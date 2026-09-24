import { estimateTokenCount } from 'tokenx';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isProviderContextPart,
  isTextPart,
  type ContentPart,
  type MessageContent,
  type MessageRecord,
  type RunContextPolicyRecord,
  type RunTerminationRecord
} from '../../shared/protocol';
import type { JsonValue } from '../../shared/conversationReliability';
import { buildTaskListTimeline, formatTaskListSnapshotForContext } from '../../shared/taskListProjection';
import { isInternalMessage } from '../../shared/messagePresentation';
import { canonicalSha256 } from '../reliability/canonicalJson';
import { modelContextProjectionFingerprint } from './projectionFingerprint';
import { normalizeToolTurnSequence } from './toolTurnNormalizer';
import {
  compressionVariantSourceFingerprint,
  messageRevisionSourceFingerprint,
  runTerminationSourceFingerprint,
  runtimeContextSnapshotSourceFingerprint,
  toolCallSourceFingerprint
} from './sourceFingerprint';
import type {
  ModelContextDiagnostic,
  ModelContextFactView,
  ModelContextIrItem,
  ModelContextMessageSelection,
  ModelContextProjection,
  ModelContextPurpose,
  ModelContextSourceRef,
  ModelTurnRef
} from './types';

const DEFAULT_LAST_N = 20;
const MAX_SYNTHETIC_CONTEXT_CHARS = 12_000;
const MAX_JSON_PREVIEW_CHARS = 4_000;

interface ProjectionIndexes {
  messages: Map<string, MessageRecord>;
  revisions: Map<string, ModelContextFactView['messageRevisions'][number]>;
  runs: Map<string, ModelContextFactView['runs'][number]>;
  terminationsByRun: Map<string, RunTerminationRecord>;
  messageLinks: Map<string, ModelContextFactView['messageTurnLinks'][number][]>;
  toolsByMessage: Map<string, ModelContextFactView['toolCalls'][number][]>;
  /** Terminated Runs with at least one durable ToolCall need their tool exchange retained. */
  toolRunIds: Set<string>;
  modelResponsesByToolCallId: Map<string, JsonValue>;
}

interface MaterializedSequence {
  items: ModelContextIrItem[];
  contents: MessageContent[];
  sources: ModelContextSourceRef[];
}

interface SelectedCompressionVariant {
  blockId: string;
  variantId: string;
  mode: 'provider_native' | 'summary_fallback';
  boundarySeq: number;
  contents: MessageContent[];
}

export function projectModelContext(input: {
  facts: ModelContextFactView;
  purpose: ModelContextPurpose;
}): ModelContextProjection {
  const diagnostics: ModelContextDiagnostic[] = [];
  const indexes = buildIndexes(input.facts, diagnostics);
  const base = input.purpose.kind === 'turn'
    ? projectTurn(input.facts, indexes, input.purpose, diagnostics)
    : projectCompression(input.facts, indexes, input.purpose, diagnostics);
  const normalizedTools = normalizeProjectionItems(
    input.facts,
    indexes,
    base.items,
    input.purpose.kind === 'compression' ? 'compression' : input.purpose.mode
  );
  diagnostics.push(...normalizedTools.diagnostics);
  const contents = normalizedTools.contents.map(clone);
  const toolSources: ModelContextSourceRef[] = normalizedTools.referencedToolCallIds.flatMap((toolCallId) => {
    const tool = input.facts.toolCalls.find((candidate) => candidate.id === toolCallId);
    return tool ? [toolSource(indexes, tool)] : [];
  });
  const orderedSources = dedupeSources([...base.sources, ...toolSources]);
  const tokenCount = estimateModelContextTokens(contents);
  const compression = 'compression' in base
    ? base.compression as NonNullable<ModelContextProjection['compression']>
    : undefined;
  const fingerprint = modelContextProjectionFingerprint(contents, orderedSources, compression ? {
    segments: compression.segments,
    ...(compression.priorSummaryContents ? { priorSummaryContents: compression.priorSummaryContents } : {}),
    resultAddenda: compression.resultAddenda
  } : {});
  return {
    purpose: clone(input.purpose),
    items: base.items,
    contents,
    messageSelections: base.selections,
    orderedSources,
    diagnostics: dedupeDiagnostics(diagnostics),
    fingerprint,
    tokenCount,
    boundary: base.boundary,
    ...(compression ? { compression } : {})
  };
}

export function estimateModelContextTokens(contents: readonly MessageContent[]): number {
  const text = contents.flatMap((content) => content.parts.map(renderPartForTokenEstimate)).join('\n');
  const estimated = estimateTokenCount(text);
  return Number.isFinite(estimated) ? Math.max(0, estimated) : 0;
}

function projectTurn(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  purpose: Extract<ModelContextPurpose, { kind: 'turn' }>,
  diagnostics: ModelContextDiagnostic[]
): {
  items: ModelContextIrItem[];
  contents: MessageContent[];
  selections: ModelContextMessageSelection[];
  sources: ModelContextSourceRef[];
  boundary: ModelContextProjection['boundary'];
} {
  const turnModel = indexes.messages.get(purpose.turn.modelMessageId);
  const run = indexes.runs.get(purpose.turn.runId);
  if (!turnModel || turnModel.conversationId !== purpose.turn.conversationId || !run) {
    diagnostics.push({
      code: 'missing_turn',
      severity: 'error',
      message: `Model turn is incomplete: run=${purpose.turn.runId}, message=${purpose.turn.modelMessageId}.`,
      sourceId: purpose.turn.runId
    });
    return { items: [], contents: [], selections: [], sources: [], boundary: { modelMessageId: purpose.turn.modelMessageId } };
  }

  const items: ModelContextIrItem[] = [];
  const contents: MessageContent[] = [];
  const sources: ModelContextSourceRef[] = [];

  appendRuntimeSnapshots(facts, purpose.turn.runId, items, contents, sources);
  appendSourceContext(facts, indexes, purpose, diagnostics, items, contents, sources);

  const targetMessages = facts.messages
    .filter((message) => message.conversationId === purpose.turn.conversationId)
    .filter((message) => message.id !== turnModel.id && message.seq < turnModel.seq)
    .sort(compareMessages);
  const runScopedIds = new Set<string>(facts.messageTurnLinks
    .filter((link) => link.turnId === purpose.turn.runId)
    .map((link) => link.messageId));
  const eligible = targetMessages.filter((message) => isEligibleTurnMessage(
    facts,
    indexes,
    message,
    purpose,
    runScopedIds.has(message.id),
    diagnostics
  ));
  const resumeMessage = purpose.mode === 'same_run_resume'
    && runScopedIds.has(turnModel.id)
    && (turnModel.status === 'streaming' || turnModel.status === 'partial')
    ? turnModel
    : undefined;
  const runScoped = [
    ...eligible.filter((message) => runScopedIds.has(message.id)),
    ...(resumeMessage ? [resumeMessage] : [])
  ].sort(compareMessages);
  const history = eligible.filter((message) => !runScopedIds.has(message.id));
  const selectedHistory = selectHistory(history, purpose.policy);
  const selectionUniverse = resumeMessage ? [...eligible, resumeMessage].sort(compareMessages) : eligible;
  const closedSelection = closeToolExchangeSelection(facts, [...selectedHistory, ...runScoped], selectionUniverse);
  let selections = selectMessages(
    facts,
    indexes,
    closedSelection
      .map((message) => ({ message, origin: runScopedIds.has(message.id) ? 'run_scoped' as const : 'target_history' as const }))
      .sort((left, right) => compareMessages(left.message, right.message)),
    purpose.turn,
    diagnostics
  );

  const compression = selectCompressionVariant(facts, purpose, selections, diagnostics);
  if (compression) {
    const retained = selections.filter((selection) => selection.origin === 'run_scoped' || selection.seq > compression.boundarySeq);
    const compressionItem: ModelContextIrItem = {
      kind: 'compression_variant',
      blockId: compression.blockId,
      variantId: compression.variantId,
      mode: compression.mode,
      contents: clone(compression.contents)
    };
    items.push(compressionItem);
    contents.push(...clone(compression.contents));
    sources.push({
      kind: 'compressionVariant',
      id: `compressionVariant:${compression.variantId}`,
      sourceConversationId: sourceConversationIdForBlock(facts, compression.blockId),
      blockId: compression.blockId,
      variantId: compression.variantId,
      fingerprint: compressionVariantSourceFingerprint(requireCompressionVariant(facts, compression.variantId))
    });
    selections = retained;
  }

  if (purpose.policy.historyMode === 'summary' && !compression) {
    const historySelections = selections.filter((selection) => selection.origin === 'target_history');
    const summary = syntheticTranscriptContent('[Context summary]', historySelections);
    if (summary) {
      items.push({
        kind: 'synthetic_transcript',
        label: 'context_summary',
        sourceIds: historySelections.map((selection) => selection.revisionId),
        content: summary
      });
      contents.push(summary);
      for (const selection of historySelections) sources.push(messageSource(facts, indexes, selection));
    }
    selections = selections.filter((selection) => selection.origin !== 'target_history');
  }

  const materialized = materializeSelections(facts, indexes, selections, diagnostics);
  items.push(...materialized.items);
  contents.push(...materialized.contents);
  sources.push(...materialized.sources);

  return {
    items,
    contents,
    selections,
    sources,
    boundary: {
      modelMessageId: turnModel.id,
      modelSeq: turnModel.seq,
      ...(compression ? { compressionBoundarySeq: compression.boundarySeq } : {})
    }
  };
}

function projectCompression(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  purpose: Extract<ModelContextPurpose, { kind: 'compression' }>,
  diagnostics: ModelContextDiagnostic[]
): {
  items: ModelContextIrItem[];
  contents: MessageContent[];
  selections: ModelContextMessageSelection[];
  sources: ModelContextSourceRef[];
  boundary: ModelContextProjection['boundary'];
  compression: NonNullable<ModelContextProjection['compression']>;
} {
  const allMessages = facts.messages
    .filter((message) => message.conversationId === purpose.conversationId)
    .sort(compareMessages);
  if (allMessages.length === 0) {
    return {
      items: [], contents: [], selections: [], sources: [], boundary: {},
      compression: { segments: [], selectedMessageIds: [], resultAddenda: [] }
    };
  }

  const startIndex = purpose.startMessageId
    ? allMessages.findIndex((message) => message.id === purpose.startMessageId)
    : 0;
  const turnModel = purpose.sourceTurn ? indexes.messages.get(purpose.sourceTurn.modelMessageId) : undefined;
  const explicitEndIndex = purpose.endMessageId
    ? allMessages.findIndex((message) => message.id === purpose.endMessageId)
    : allMessages.length - 1;
  const endIndex = turnModel
    ? Math.min(
        explicitEndIndex < 0 ? allMessages.length - 1 : explicitEndIndex,
        allMessages.findIndex((message) => message.id === turnModel.id) - (purpose.includeSourceTurnMessage === true ? 0 : 1)
      )
    : explicitEndIndex;
  const bounded = startIndex < 0 || endIndex < startIndex
    ? []
    : allMessages.slice(startIndex, endIndex + 1);
  const resumeMode = purpose.mode === 'dry_run' ? 'dry_run' : 'fresh';
  const pseudoTurn: ModelTurnRef = purpose.sourceTurn ?? {
    conversationId: purpose.conversationId,
    runId: '',
    modelMessageId: purpose.endMessageId ?? ''
  };
  const eligible = bounded.filter((message) => isEligibleCompressionMessage(
    facts,
    indexes,
    message,
    resumeMode,
    diagnostics
  ));
  const closedIndex = lastClosedBoundaryIndex(indexes, eligible);
  const selectedMessages = purpose.methodKind === 'segmented_summary'
    ? closedIndex >= 0 ? eligible.slice(0, closedIndex + 1) : []
    : eligible;

  const predecessor = !purpose.startMessageId && selectedMessages.length > 0
    ? selectCompressionPredecessor(facts, purpose, selectedMessages[selectedMessages.length - 1].seq)
    : undefined;
  const predecessorVariant = predecessor
    ? preferredCompressionVariant(facts, predecessor.id, purpose.methodKind)
    : undefined;
  const predecessorBoundary = predecessor?.endSeq ?? predecessor?.anchorSeq ?? 0;
  const incrementalMessages = predecessor
    ? selectedMessages.filter((message) => message.seq > predecessorBoundary)
    : selectedMessages;
  const selections = selectMessages(
    facts,
    indexes,
    incrementalMessages.map((message) => ({ message, origin: 'compression_source' as const })),
    pseudoTurn,
    diagnostics
  );
  const materialized = materializeSelections(facts, indexes, selections, diagnostics);
  const priorSummary = predecessorVariant ? clone(predecessorVariant.contents) : undefined;
  const contents = [...(priorSummary ?? []), ...materialized.contents];
  const items: ModelContextIrItem[] = [];
  const sources: ModelContextSourceRef[] = [];
  if (predecessor && predecessorVariant) {
    items.push({
      kind: 'compression_variant',
      blockId: predecessor.id,
      variantId: predecessorVariant.id,
      mode: predecessorVariant.kind === 'provider_native' ? 'provider_native' : 'summary_fallback',
      contents: clone(predecessorVariant.contents)
    });
    sources.push({
      kind: 'compressionVariant',
      id: `compressionVariant:${predecessorVariant.id}`,
      sourceConversationId: sourceConversationIdForBlock(facts, predecessor.id),
      blockId: predecessor.id,
      variantId: predecessorVariant.id,
      fingerprint: compressionVariantSourceFingerprint(predecessorVariant)
    });
  }
  items.push(...materialized.items);
  sources.push(...materialized.sources);

  const segments = segmentSelections(facts, indexes, selections, diagnostics);
  const anchor = incrementalMessages[incrementalMessages.length - 1];
  const taskList = anchor
    ? compressionTaskListSnapshot(facts, indexes, purpose.conversationId, anchor.seq, pseudoTurn, diagnostics)
    : { addenda: [] as MessageContent[], sources: [] as ModelContextSourceRef[] };
  sources.push(...taskList.sources);
  return {
    items,
    contents,
    selections,
    sources,
    boundary: {
      ...(turnModel ? { modelMessageId: turnModel.id, modelSeq: turnModel.seq } : {}),
      ...(predecessor ? { compressionBoundarySeq: predecessorBoundary } : {})
    },
    compression: {
      segments,
      selectedMessageIds: incrementalMessages.map((message) => message.id),
      ...(anchor ? { anchorMessageId: anchor.id, anchorSeq: anchor.seq } : {}),
      ...(predecessor ? { priorBlockId: predecessor.id } : {}),
      ...(predecessorVariant ? { priorVariantId: predecessorVariant.id, priorSummaryContents: clone(predecessorVariant.contents) } : {}),
      resultAddenda: taskList.addenda
    }
  };
}

function buildIndexes(facts: ModelContextFactView, diagnostics: ModelContextDiagnostic[]): ProjectionIndexes {
  const messages = uniqueMap(facts.messages, 'Message');
  const revisions = uniqueMap(facts.messageRevisions, 'MessageRevision');
  const runs = uniqueMap(facts.runs, 'Run');
  const terminationsByRun = new Map<string, RunTerminationRecord>();
  for (const termination of facts.runTerminations) {
    if (!runs.has(termination.runId)) {
      diagnostics.push({ code: 'orphan_run_termination', severity: 'error', message: `RunTermination ${termination.id} has no Run.`, sourceId: termination.id });
      continue;
    }
    if (terminationsByRun.has(termination.runId)) throw new Error(`Run ${termination.runId} has multiple termination facts.`);
    terminationsByRun.set(termination.runId, termination);
  }
  const messageLinks = new Map<string, ModelContextFactView['messageTurnLinks'][number][]>();
  for (const link of facts.messageTurnLinks) {
    const links = messageLinks.get(link.messageId) ?? [];
    links.push(link);
    messageLinks.set(link.messageId, links);
  }
  const toolsByMessage = new Map<string, ModelContextFactView['toolCalls'][number][]>();
  for (const tool of facts.toolCalls) {
    const tools = toolsByMessage.get(tool.messageId) ?? [];
    tools.push(tool);
    toolsByMessage.set(tool.messageId, tools);
  }
  const toolRunIds = new Set<string>();
  for (const [messageId, tools] of toolsByMessage) {
    if (tools.length === 0) continue;
    for (const link of messageLinks.get(messageId) ?? []) toolRunIds.add(link.turnId);
  }
  const modelResponsesByToolCallId = toolModelResponses(facts);
  for (const tools of toolsByMessage.values()) {
    tools.sort((left, right) => (left.schedulingOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.schedulingOrdinal ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id));
  }
  return { messages, revisions, runs, terminationsByRun, messageLinks, toolsByMessage, toolRunIds, modelResponsesByToolCallId };
}

function appendRuntimeSnapshots(
  facts: ModelContextFactView,
  runId: string,
  items: ModelContextIrItem[],
  contents: MessageContent[],
  sources: ModelContextSourceRef[]
): void {
  const snapshots = facts.runRuntimeContextSnapshotLinks
    .filter((link) => link.runId === runId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .flatMap((link) => {
      const snapshot = facts.runtimeContextSnapshots.find((candidate) => candidate.id === link.runtimeContextSnapshotId);
      return snapshot ? [{ link, snapshot }] : [];
    });
  for (const { snapshot } of snapshots) {
    const text = snapshot.text.trim();
    if (!text) continue;
    const content = textContent(text);
    items.push({ kind: 'runtime_snapshot', runId, snapshotId: snapshot.id, content });
    contents.push(content);
    sources.push({
      kind: 'runtimeContextSnapshot',
      id: `runtimeContextSnapshot:${snapshot.id}`,
      sourceConversationId: sourceConversationIdForRun(facts, runId),
      snapshotId: snapshot.id,
      runId,
      fingerprint: runtimeContextSnapshotSourceFingerprint(snapshot)
    });
  }
}

function appendSourceContext(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  purpose: Extract<ModelContextPurpose, { kind: 'turn' }>,
  diagnostics: ModelContextDiagnostic[],
  items: ModelContextIrItem[],
  contents: MessageContent[],
  sources: ModelContextSourceRef[]
): void {
  const links = facts.runSources.filter((source) => source.runId === purpose.turn.runId);
  if (links.length > 1) throw new Error(`Run ${purpose.turn.runId} has multiple source facts.`);
  const source = links[0];
  if (!source) return;

  if (purpose.policy.includeSourceContext === true
    && source.sourceConversationId
    && source.sourceConversationId !== purpose.turn.conversationId) {
    const sourceMessages = facts.messages
      .filter((message) => message.conversationId === source.sourceConversationId)
      .sort(compareMessages);
    const boundary = source.sourceMessageId
      ? indexes.messages.get(source.sourceMessageId)?.seq
      : source.sourceToolCallId
        ? indexes.messages.get(facts.toolCalls.find((tool) => tool.id === source.sourceToolCallId)?.messageId ?? '')?.seq
        : undefined;
    if (boundary === undefined) {
      diagnostics.push({
        code: 'source_boundary_missing',
        severity: 'warning',
        message: `Run ${purpose.turn.runId} source context has no frozen Message boundary.`,
        sourceId: source.id
      });
    } else {
      const eligible = sourceMessages
        .filter((message) => message.seq <= boundary)
        .filter((message) => isEligibleCompressionMessage(facts, indexes, message, purpose.mode, diagnostics));
      const selected = selectHistory(eligible, purpose.policy);
      const selections = selectMessages(
        facts,
        indexes,
        selected.map((message) => ({ message, origin: 'source_history' as const })),
        purpose.turn,
        diagnostics
      );
      const materialized = materializeSelections(facts, indexes, selections, diagnostics);
      const sourceBlock = syntheticContentsBlock('[Source conversation context]', materialized.contents);
      if (sourceBlock) {
        items.push({ kind: 'synthetic_transcript', label: 'source_conversation', sourceIds: selections.map((selection) => selection.revisionId), content: sourceBlock });
        contents.push(sourceBlock);
        sources.push(...materialized.sources);
      }
    }
  }

  if (purpose.policy.includeSourceToolResult === true && source.sourceToolCallId) {
    const tool = facts.toolCalls.find((candidate) => candidate.id === source.sourceToolCallId);
    if (tool) {
      const block = sourceToolContent(tool, indexes.modelResponsesByToolCallId.get(tool.id));
      items.push({ kind: 'synthetic_transcript', label: 'source_tool', sourceIds: [tool.id], content: block });
      contents.push(block);
      sources.push(toolSource(indexes, tool));
    }
  }
}

function isEligibleTurnMessage(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  message: MessageRecord,
  purpose: Extract<ModelContextPurpose, { kind: 'turn' }>,
  runScoped: boolean,
  diagnostics: ModelContextDiagnostic[]
): boolean {
  if (excludeTerminatedRunWithoutToolFacts(indexes, message, diagnostics)) return false;
  if (isInternalMessage(message)) {
    const attachedToCurrentRun = (indexes.messageLinks.get(message.id) ?? [])
      .some((link) => link.turnId === purpose.turn.runId && link.role === 'notification');
    if (!attachedToCurrentRun) {
      diagnostics.push({
        code: 'internal_message_target_mismatch',
        severity: 'info',
        message: `Internal Message ${message.id} is not attached to target Run ${purpose.turn.runId} and was excluded.`,
        sourceId: message.id
      });
    }
    return attachedToCurrentRun;
  }
  if (message.status === 'streaming') {
    const includeResume = purpose.mode === 'same_run_resume' && runScoped;
    if (!includeResume) diagnostics.push({ code: 'streaming_message_excluded', severity: 'info', message: `Streaming Message ${message.id} was excluded.`, sourceId: message.id });
    return includeResume;
  }
  if (isForeignActiveRunInput(facts, indexes, message.id, purpose.turn.runId)) {
    diagnostics.push({
      code: 'foreign_active_run_input_excluded',
      severity: 'warning',
      message: `Message ${message.id} belongs to another queued/active Run and was excluded from ${purpose.turn.runId}.`,
      sourceId: message.id
    });
    return false;
  }
  if (message.role === 'model' && message.status === 'partial') {
    const termination = terminationForMessage(indexes, message.id);
    if (!termination) {
      diagnostics.push({
        code: 'unattributed_partial_excluded',
        severity: 'warning',
        message: `Partial model Message ${message.id} has no termination fact and was excluded.`,
        sourceId: message.id
      });
      return false;
    }
  }
  return true;
}

function isEligibleCompressionMessage(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  message: MessageRecord,
  mode: 'fresh' | 'same_run_resume' | 'dry_run' | 'auto' | 'manual',
  diagnostics: ModelContextDiagnostic[]
): boolean {
  if (excludeTerminatedRunWithoutToolFacts(indexes, message, diagnostics)) return false;
  if (isInternalMessage(message)) {
    diagnostics.push({ code: 'internal_message_excluded', severity: 'info', message: `Internal Message ${message.id} was excluded from compression.`, sourceId: message.id });
    return false;
  }
  if (message.status === 'streaming') {
    diagnostics.push({ code: 'streaming_message_excluded', severity: 'info', message: `Streaming Message ${message.id} was excluded from compression.`, sourceId: message.id });
    return false;
  }
  if (message.role === 'model' && message.status === 'partial' && !terminationForMessage(indexes, message.id)) {
    diagnostics.push({ code: 'unattributed_partial_excluded', severity: 'warning', message: `Partial model Message ${message.id} has no termination fact and was excluded from compression.`, sourceId: message.id });
    return false;
  }
  return !message.content.parts.every(isProviderContextPart) || message.status === 'partial';
}

/**
 * A terminated Run without a durable ToolCall has no model-visible fact worth replaying. Its input
 * and partial model body form one cancelled/failed empty task and are excluded as a unit. Runs with
 * ToolCall facts are retained so the normalizer can preserve committed results or close unresolved
 * calls with a structured interrupted response.
 */
function excludeTerminatedRunWithoutToolFacts(
  indexes: ProjectionIndexes,
  message: MessageRecord,
  diagnostics: ModelContextDiagnostic[]
): boolean {
  const excludedRunId = (indexes.messageLinks.get(message.id) ?? []).find((link) => {
    if (!indexes.terminationsByRun.has(link.turnId) || indexes.toolRunIds.has(link.turnId)) return false;
    return link.role === 'input' || (link.role === 'model' && message.status === 'partial');
  })?.turnId;
  if (!excludedRunId) return false;
  diagnostics.push({
    code: 'terminated_run_without_tool_facts_excluded',
    severity: 'info',
    message: `Message ${message.id} from terminated Run ${excludedRunId} was excluded because the Run has no durable ToolCall facts.`,
    sourceId: message.id
  });
  return true;
}

function isForeignActiveRunInput(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  messageId: string,
  currentRunId: string
): boolean {
  return (indexes.messageLinks.get(messageId) ?? []).some((link) => {
    // `notification` is the protocol role for an internal queued input. Tool responses
    // have already been admitted to a Run and must retain their normal history semantics.
    if ((link.role !== 'input' && link.role !== 'notification') || link.turnId === currentRunId) return false;
    const run = indexes.runs.get(link.turnId);
    return run?.lifecycle === 'queued' || run?.lifecycle === 'active';
  });
}

function closeToolExchangeSelection(
  facts: ModelContextFactView,
  initiallySelected: readonly MessageRecord[],
  eligible: readonly MessageRecord[]
): MessageRecord[] {
  const eligibleById = new Map(eligible.map((message) => [message.id, message]));
  const selectedIds = new Set(initiallySelected.map((message) => message.id));
  const responseMessagesByAlias = new Map<string, Set<string>>();
  for (const message of eligible) {
    for (const part of message.content.parts) {
      if (!isFunctionResponsePart(part)) continue;
      const aliases = part.id?.trim() ? [part.id.trim()] : [`name:${part.functionResponse.name}`];
      for (const alias of aliases) {
        const ids = responseMessagesByAlias.get(alias) ?? new Set<string>();
        ids.add(message.id);
        responseMessagesByAlias.set(alias, ids);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const tool of facts.toolCalls) {
      const callMessage = eligibleById.get(tool.messageId);
      if (!callMessage) continue;
      const aliases = [tool.functionCallId, tool.id].filter((value): value is string => !!value);
      let responseMessageIds = new Set<string>();
      for (const alias of aliases) {
        for (const messageId of responseMessagesByAlias.get(alias) ?? []) responseMessageIds.add(messageId);
      }
      if (responseMessageIds.size === 0) {
        const nameMatches = responseMessagesByAlias.get(`name:${tool.name}`) ?? new Set<string>();
        if (nameMatches.size === 1) responseMessageIds = new Set(nameMatches);
      }
      const exchangeSelected = selectedIds.has(callMessage.id) || [...responseMessageIds].some((messageId) => selectedIds.has(messageId));
      if (!exchangeSelected) continue;
      if (!selectedIds.has(callMessage.id)) {
        selectedIds.add(callMessage.id);
        changed = true;
      }
      for (const messageId of responseMessageIds) {
        if (selectedIds.has(messageId)) continue;
        selectedIds.add(messageId);
        changed = true;
      }
    }
  }
  return eligible.filter((message) => selectedIds.has(message.id));
}

function selectHistory(messages: readonly MessageRecord[], policy: RunContextPolicyRecord): MessageRecord[] {
  switch (policy.historyMode) {
    case 'none': return [];
    case 'last_n': return messages.slice(-positiveInt(policy.lastN, DEFAULT_LAST_N));
    case 'since_message': {
      if (!policy.sinceMessageId) return [...messages];
      const index = messages.findIndex((message) => message.id === policy.sinceMessageId);
      return index >= 0 ? messages.slice(index) : [];
    }
    case 'selected_messages': {
      const ids = new Set(policy.selectedMessageIds ?? []);
      return messages.filter((message) => ids.has(message.id));
    }
    case 'summary':
    case 'full':
      return [...messages];
  }
}

function selectMessages(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  selected: readonly { message: MessageRecord; origin: ModelContextMessageSelection['origin'] }[],
  turn: ModelTurnRef,
  diagnostics: ModelContextDiagnostic[]
): ModelContextMessageSelection[] {
  return selected.flatMap(({ message, origin }) => {
    const revision = resolveRevision(facts, indexes, message, turn.runId, diagnostics);
    if (!revision) return [];
    const termination = terminationForMessage(indexes, message.id);
    const materialization = message.role === 'model' && message.status === 'partial' && termination
      ? 'tool_facts_only' as const
      : 'verbatim' as const;
    const content = materialization === 'tool_facts_only'
      ? toolFactsOnlyContent(indexes, message.id)
      : clone(revision.content);
    return [{
      messageId: message.id,
      revisionId: revision.id,
      conversationId: message.conversationId,
      runIds: [...new Set((indexes.messageLinks.get(message.id) ?? []).map((link) => link.turnId))],
      seq: message.seq,
      role: message.role,
      origin,
      materialization,
      content
    }];
  });
}

function resolveRevision(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  message: MessageRecord,
  runId: string,
  diagnostics: ModelContextDiagnostic[]
): ModelContextFactView['messageRevisions'][number] | undefined {
  const frozen = runId
    ? facts.inputRevisions.filter((input) => input.runId === runId && input.messageId === message.id)
    : [];
  if (frozen.length > 1) {
    diagnostics.push({ code: 'ambiguous_revision_link', severity: 'error', message: `Message ${message.id} has multiple frozen revisions for Run ${runId}.`, sourceId: message.id });
    return undefined;
  }
  const current = facts.messageCurrentRevisionLinks.filter((link) => link.messageId === message.id);
  if (frozen.length === 0 && current.length !== 1) {
    diagnostics.push({
      code: current.length > 1 ? 'ambiguous_revision_link' : 'missing_revision_link',
      severity: 'error',
      message: `Message ${message.id} has ${current.length} current revision links.`,
      sourceId: message.id
    });
    return undefined;
  }
  const revisionId = frozen[0]?.revisionId ?? current[0]?.revisionId;
  const revision = revisionId ? indexes.revisions.get(revisionId) : undefined;
  if (!revision || revision.messageId !== message.id) {
    diagnostics.push({ code: 'missing_revision', severity: 'error', message: `Message ${message.id} revision ${revisionId ?? '[missing]'} is unavailable.`, sourceId: message.id });
    return undefined;
  }
  return revision;
}

function materializeSelections(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  selections: readonly ModelContextMessageSelection[],
  diagnostics: ModelContextDiagnostic[]
): MaterializedSequence {
  const items: ModelContextIrItem[] = [];
  const contents: MessageContent[] = [];
  const sources: ModelContextSourceRef[] = [];
  const lastIndexByTerminatedRun = new Map<string, number>();
  const modelSeenByTerminatedRun = new Set<string>();

  selections.forEach((selection, index) => {
    for (const link of indexes.messageLinks.get(selection.messageId) ?? []) {
      if (!indexes.terminationsByRun.has(link.turnId)) continue;
      lastIndexByTerminatedRun.set(link.turnId, index);
      if (link.role === 'model') modelSeenByTerminatedRun.add(link.turnId);
    }
  });

  selections.forEach((selection, index) => {
    items.push({ kind: 'message', selection });
    if (selection.content.parts.length > 0) contents.push(clone(selection.content));
    sources.push(messageSource(facts, indexes, selection));
    if (selection.materialization === 'tool_facts_only') {
      for (const tool of indexes.toolsByMessage.get(selection.messageId) ?? []) {
        sources.push(toolSource(indexes, tool));
      }
    }

    for (const [runId, lastIndex] of lastIndexByTerminatedRun) {
      if (lastIndex !== index || !modelSeenByTerminatedRun.has(runId)) continue;
      const termination = indexes.terminationsByRun.get(runId);
      if (!termination) continue;
      items.push({ kind: 'interruption_boundary', runId, termination });
      sources.push(runTerminationSource(facts, termination));
    }
  });
  return { items, contents, sources };
}

function selectCompressionVariant(
  facts: ModelContextFactView,
  purpose: Extract<ModelContextPurpose, { kind: 'turn' }>,
  selections: readonly ModelContextMessageSelection[],
  diagnostics: ModelContextDiagnostic[]
): SelectedCompressionVariant | undefined {
  const modelSeq = facts.messages.find((message) => message.id === purpose.turn.modelMessageId)?.seq ?? Number.MAX_SAFE_INTEGER;
  const exactLinks = facts.runCompressionBlockLinks
    .filter((link) => link.runId === purpose.turn.runId)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
  for (const link of exactLinks) {
    const block = facts.compressionBlocks.find((candidate) => candidate.id === link.blockId);
    const variant = link.variantId
      ? facts.compressionContextVariants.find((candidate) => candidate.id === link.variantId && candidate.blockId === link.blockId)
      : preferredTurnVariant(facts, link.blockId, purpose);
    const boundarySeq = block?.endSeq ?? block?.anchorSeq;
    if (!block || block.status !== 'complete' || block.staleReason || !variant || boundarySeq === undefined || boundarySeq >= modelSeq) {
      diagnostics.push({ code: 'compression_variant_incompatible', severity: 'warning', message: `Run compression link ${link.id} is not usable for this turn.`, sourceId: link.id });
      continue;
    }
    if (!variantCompatible(variant, purpose)) continue;
    return {
      blockId: block.id,
      variantId: variant.id,
      mode: variant.kind === 'provider_native' ? 'provider_native' : 'summary_fallback',
      boundarySeq,
      contents: clone(variant.contents)
    };
  }

  if (purpose.mode === 'dry_run' || (purpose.policy.historyMode !== 'full' && purpose.policy.historyMode !== 'summary')) return undefined;
  const maxEligibleSeq = selections
    .filter((selection) => selection.origin === 'target_history')
    .reduce((max, selection) => Math.max(max, selection.seq), 0);
  const candidates = facts.compressionBlocks
    .filter((block) => block.conversationId === purpose.turn.conversationId
      && block.status === 'complete'
      && !block.staleReason
      && (block.endSeq ?? block.anchorSeq ?? 0) <= maxEligibleSeq
      && (block.endSeq ?? block.anchorSeq ?? 0) < modelSeq)
    .sort((left, right) => (right.endSeq ?? right.anchorSeq ?? 0) - (left.endSeq ?? left.anchorSeq ?? 0)
      || right.updatedAt - left.updatedAt
      || right.id.localeCompare(left.id));
  for (const block of candidates) {
    const variant = preferredTurnVariant(facts, block.id, purpose);
    if (!variant || !variantCompatible(variant, purpose)) continue;
    return {
      blockId: block.id,
      variantId: variant.id,
      mode: variant.kind === 'provider_native' ? 'provider_native' : 'summary_fallback',
      boundarySeq: block.endSeq ?? block.anchorSeq ?? 0,
      contents: clone(variant.contents)
    };
  }
  return undefined;
}

function preferredTurnVariant(
  facts: ModelContextFactView,
  blockId: string,
  purpose: Extract<ModelContextPurpose, { kind: 'turn' }>
): ModelContextFactView['compressionContextVariants'][number] | undefined {
  const variants = facts.compressionContextVariants
    .filter((variant) => variant.blockId === blockId)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
  const nativeAllowed = (purpose.settingsSnapshot?.provider === 'openai-responses'
    || purpose.settingsSnapshot?.provider === 'claude')
    && purpose.settingsSnapshot.compressionMethodKind === 'provider_native';
  return (nativeAllowed ? variants.find((variant) => variant.kind === 'provider_native') : undefined)
    ?? variants.find((variant) => variant.kind === 'provider_neutral_summary');
}

function variantCompatible(
  variant: ModelContextFactView['compressionContextVariants'][number],
  purpose: Extract<ModelContextPurpose, { kind: 'turn' }>
): boolean {
  if (variant.kind !== 'provider_native') return true;
  if (purpose.settingsSnapshot?.provider !== 'openai-responses'
    && purpose.settingsSnapshot?.provider !== 'claude') return false;
  const compatibility = variant.compatibility;
  if (!compatibility) return true;
  if (compatibility.provider && compatibility.provider !== purpose.settingsSnapshot.provider) return false;
  if (compatibility.providerConfigId && compatibility.providerConfigId !== purpose.settingsSnapshot.providerConfigId) return false;
  if (compatibility.model && compatibility.model !== purpose.settingsSnapshot.modelId) return false;
  return true;
}

function selectCompressionPredecessor(
  facts: ModelContextFactView,
  purpose: Extract<ModelContextPurpose, { kind: 'compression' }>,
  anchorSeq: number
): ModelContextFactView['compressionBlocks'][number] | undefined {
  return facts.compressionBlocks
    .filter((block) => block.conversationId === purpose.conversationId
      && block.status === 'complete'
      && !block.staleReason
      && block.methodKind === purpose.methodKind
      && (block.endSeq ?? block.anchorSeq ?? 0) < anchorSeq)
    .filter((block) => preferredCompressionVariant(facts, block.id, purpose.methodKind) !== undefined)
    .sort((left, right) => (right.endSeq ?? right.anchorSeq ?? 0) - (left.endSeq ?? left.anchorSeq ?? 0)
      || right.updatedAt - left.updatedAt
      || right.id.localeCompare(left.id))[0];
}

function preferredCompressionVariant(
  facts: ModelContextFactView,
  blockId: string,
  methodKind: ModelContextFactView['compressionBlocks'][number]['methodKind']
): ModelContextFactView['compressionContextVariants'][number] | undefined {
  const variants = facts.compressionContextVariants
    .filter((variant) => variant.blockId === blockId)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
  return methodKind === 'provider_native'
    ? variants.find((variant) => variant.kind === 'provider_native') ?? variants.find((variant) => variant.kind === 'provider_neutral_summary')
    : variants.find((variant) => variant.kind === 'provider_neutral_summary');
}

function compressionTaskListSnapshot(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  conversationId: string,
  boundarySeq: number,
  turn: ModelTurnRef,
  diagnostics: ModelContextDiagnostic[]
): { addenda: MessageContent[]; sources: ModelContextSourceRef[] } {
  const messages = facts.messages
    .filter((message) => message.conversationId === conversationId && message.seq <= boundarySeq)
    .sort(compareMessages)
    .filter((message) => isEligibleCompressionMessage(facts, indexes, message, 'fresh', diagnostics));
  const selections = selectMessages(
    facts,
    indexes,
    messages.map((message) => ({ message, origin: 'compression_source' as const })),
    turn,
    diagnostics
  );
  const selectedIds = new Set(selections.map((selection) => selection.messageId));
  const messageRecords = selections.flatMap((selection) => {
    const message = indexes.messages.get(selection.messageId);
    return message ? [{ ...message, content: clone(selection.content) }] : [];
  });
  const toolCalls = facts.toolCalls.filter((tool) => selectedIds.has(tool.messageId));
  const snapshot = buildTaskListTimeline({ messages: messageRecords, toolCalls, conversationId }).snapshot;
  if (snapshot.stats.total <= 0) return { addenda: [], sources: [] };
  const text = formatTaskListSnapshotForContext(snapshot).trim();
  if (!text) return { addenda: [], sources: [] };
  return {
    addenda: [textContent(text)],
    sources: [
      ...selections.map((selection) => messageSource(facts, indexes, selection)),
      ...toolCalls.map((tool) => toolSource(indexes, tool))
    ]
  };
}

function segmentSelections(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  selections: readonly ModelContextMessageSelection[],
  diagnostics: ModelContextDiagnostic[]
): MessageContent[][] {
  const groups: ModelContextMessageSelection[][] = [];
  let current: ModelContextMessageSelection[] = [];
  let closed = false;
  for (const selection of selections) {
    const hasFunctionResponse = selection.content.parts.some(isFunctionResponsePart);
    if (closed && selection.role === 'user' && !hasFunctionResponse) {
      groups.push(current);
      current = [];
      closed = false;
    }
    current.push(selection);
    if (selection.role === 'model') {
      const termination = terminationForMessage(indexes, selection.messageId);
      closed = !!termination || (selection.content.parts.some((part) => isTextPart(part) && part.thought !== true && part.text.trim().length > 0)
        && !selection.content.parts.some(isFunctionCallPart));
    } else if (hasFunctionResponse) {
      closed = true;
    }
  }
  if (current.length > 0 && closed) groups.push(current);
  return groups.map((group) => {
    const materialized = materializeSelections(facts, indexes, group, diagnostics);
    const normalized = normalizeProjectionItems(facts, indexes, materialized.items, 'compression');
    diagnostics.push(...normalized.diagnostics);
    return normalized.contents.map(clone);
  });
}

function lastClosedBoundaryIndex(indexes: ProjectionIndexes, messages: readonly MessageRecord[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (terminationForMessage(indexes, message.id)) return index;
    if (message.content.role === 'model') {
      if (message.content.parts.some((part) => isTextPart(part) && part.thought !== true && part.text.trim().length > 0)
        && !message.content.parts.some(isFunctionCallPart)) return index;
    } else if (message.content.parts.some(isFunctionResponsePart)
      || message.content.parts.some((part) => isTextPart(part) && part.text.trim().length > 0)) return index;
  }
  return -1;
}

function terminationForMessage(indexes: ProjectionIndexes, messageId: string): RunTerminationRecord | undefined {
  const modelLink = (indexes.messageLinks.get(messageId) ?? []).find((link) => link.role === 'model');
  return modelLink ? indexes.terminationsByRun.get(modelLink.turnId) : undefined;
}

function toolFactsOnlyContent(indexes: ProjectionIndexes, messageId: string): MessageContent {
  const parts = (indexes.toolsByMessage.get(messageId) ?? []).map((tool) => ({
    id: tool.functionCallId ?? tool.id,
    functionCall: {
      name: tool.name,
      args: parseJson(tool.args)
    }
  }));
  return { role: 'model', parts };
}

function syntheticTranscriptContent(title: string, selections: readonly ModelContextMessageSelection[]): MessageContent | undefined {
  if (selections.length === 0) return undefined;
  const body = selections.map((selection) => renderMessageContent(selection.role, selection.messageId, selection.content)).filter(Boolean).join('\n\n');
  return body ? textContent(`${title}\n${truncate(body, MAX_SYNTHETIC_CONTEXT_CHARS)}`) : undefined;
}

function syntheticContentsBlock(title: string, contents: readonly MessageContent[]): MessageContent | undefined {
  if (contents.length === 0) return undefined;
  const body = contents.map((content, index) => renderMessageContent(content.role === 'model' ? 'model' : 'user', `source-${index + 1}`, content)).join('\n\n');
  return body ? textContent(`${title}\n${truncate(body, MAX_SYNTHETIC_CONTEXT_CHARS)}`) : undefined;
}

function sourceToolContent(tool: ModelContextFactView['toolCalls'][number], modelResponse?: JsonValue): MessageContent {
  return textContent(truncate([
    '[Source tool call]',
    `id: ${tool.id}`,
    `name: ${tool.name}`,
    `args: ${jsonPreview(parseJson(tool.args))}`,
    `status: ${tool.status}`,
    ...(modelResponse !== undefined ? [`result: ${jsonPreview(modelResponse)}`] : []),
    ...(tool.error ? [`error: ${tool.error}`] : []),
    ...(tool.durationMs !== undefined ? [`durationMs: ${tool.durationMs}`] : [])
  ].join('\n'), MAX_SYNTHETIC_CONTEXT_CHARS));
}

function messageSource(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  selection: ModelContextMessageSelection
): ModelContextSourceRef {
  const revision = indexes.revisions.get(selection.revisionId);
  const message = indexes.messages.get(selection.messageId);
  if (!revision || !message) throw new Error(`Cannot fingerprint missing Message source ${selection.messageId}:${selection.revisionId}.`);
  return {
    kind: 'messageRevision',
    id: `messageRevision:${selection.revisionId}`,
    sourceConversationId: selection.conversationId,
    messageId: selection.messageId,
    revisionId: selection.revisionId,
    seq: selection.seq,
    fingerprint: messageRevisionSourceFingerprint({
      revision,
      message,
      runIds: selection.runIds,
      terminations: selection.runIds.flatMap((runId) => {
        const termination = indexes.terminationsByRun.get(runId);
        return termination ? [termination] : [];
      })
    })
  };
}

function toolSource(indexes: ProjectionIndexes, tool: ModelContextFactView['toolCalls'][number]): ModelContextSourceRef {
  const message = indexes.messages.get(tool.messageId);
  if (!message) throw new Error(`Cannot fingerprint ToolCall ${tool.id} without Message ${tool.messageId}.`);
  return {
    kind: 'toolCall',
    id: `toolCall:${tool.id}`,
    sourceConversationId: message.conversationId,
    toolCallId: tool.id,
    messageId: tool.messageId,
    fingerprint: toolCallSourceFingerprint(tool, indexes.modelResponsesByToolCallId.get(tool.id))
  };
}

function runTerminationSource(facts: ModelContextFactView, termination: RunTerminationRecord): ModelContextSourceRef {
  return {
    kind: 'runTermination',
    id: `runTermination:${termination.id}`,
    sourceConversationId: sourceConversationIdForRun(facts, termination.runId),
    runId: termination.runId,
    terminationId: termination.id,
    fingerprint: runTerminationSourceFingerprint(termination)
  };
}

function sourceConversationIdForRun(facts: ModelContextFactView, runId: string): string {
  const run = facts.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Cannot identify source conversation for Run ${runId}.`);
  return run.conversationId;
}

function sourceConversationIdForBlock(facts: ModelContextFactView, blockId: string): string {
  const block = facts.compressionBlocks.find((candidate) => candidate.id === blockId);
  if (!block) throw new Error(`Cannot identify source conversation for CompressionBlock ${blockId}.`);
  return block.conversationId;
}

function requireCompressionVariant(
  facts: ModelContextFactView,
  variantId: string
): ModelContextFactView['compressionContextVariants'][number] {
  const variant = facts.compressionContextVariants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Selected compression context variant is missing: ${variantId}`);
  return variant;
}

function normalizeProjectionItems(
  facts: ModelContextFactView,
  indexes: ProjectionIndexes,
  items: readonly ModelContextIrItem[],
  purpose: 'fresh' | 'compression' | 'same_run_resume' | 'dry_run'
) {
  const runIdsByMessage = new Map<string, readonly string[]>();
  for (const link of facts.messageTurnLinks) {
    runIdsByMessage.set(link.messageId, [...new Set([...(runIdsByMessage.get(link.messageId) ?? []), link.turnId])]);
  }
  return normalizeToolTurnSequence({
    entries: toolSequenceEntries(items),
    toolCalls: facts.toolCalls,
    modelResponsesByToolCallId: indexes.modelResponsesByToolCallId,
    runIdsByMessage,
    terminationsByRun: indexes.terminationsByRun,
    purpose
  });
}

function toolModelResponses(facts: ModelContextFactView): Map<string, JsonValue> {
  const artifacts = new Map(facts.toolResultArtifacts.map((artifact) => [artifact.id, artifact]));
  const result = new Map<string, JsonValue>();
  for (const link of facts.toolCallResultLinks) {
    if (link.role !== 'final') continue;
    const artifact = artifacts.get(link.artifactId);
    if (!artifact) throw new Error(`ToolCallResultLink ${link.id} references missing Artifact ${link.artifactId}.`);
    if (result.has(link.toolCallId)) throw new Error(`ToolCall ${link.toolCallId} has multiple final result links.`);
    result.set(link.toolCallId, clone(artifact.modelResponse));
  }
  return result;
}

function toolSequenceEntries(items: readonly ModelContextIrItem[]): Array<
  | { kind: 'content'; content: MessageContent; messageId?: string }
  | { kind: 'termination'; termination: RunTerminationRecord }
> {
  const entries: Array<
    | { kind: 'content'; content: MessageContent; messageId?: string }
    | { kind: 'termination'; termination: RunTerminationRecord }
  > = [];
  for (const item of items) {
    switch (item.kind) {
      case 'message':
        entries.push({ kind: 'content', content: clone(item.selection.content), messageId: item.selection.messageId });
        break;
      case 'compression_variant':
        entries.push(...item.contents.map((content) => ({ kind: 'content' as const, content: clone(content) })));
        break;
      case 'interruption_boundary':
        entries.push({ kind: 'termination', termination: clone(item.termination) });
        break;
      case 'runtime_snapshot':
      case 'synthetic_transcript':
        entries.push({ kind: 'content', content: clone(item.content) });
        break;
    }
  }
  return entries;
}

function dedupeSources(sources: readonly ModelContextSourceRef[]): ModelContextSourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
}

function dedupeDiagnostics(diagnostics: readonly ModelContextDiagnostic[]): ModelContextDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}\u0000${diagnostic.severity}\u0000${diagnostic.sourceId ?? ''}\u0000${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderMessageContent(role: MessageRecord['role'], id: string, content: MessageContent): string {
  const body = content.parts.map(renderPartForTranscript).filter(Boolean).join('\n');
  return `${role} ${id}: ${body || '[empty]'}`;
}

function renderPartForTranscript(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[function_call name=${part.functionCall.name} args=${jsonPreview(part.functionCall.args)}]`;
  if (isFunctionResponsePart(part)) return `[function_response name=${part.functionResponse.name} response=${jsonPreview(part.functionResponse.response)}]`;
  if (isInlineDataPart(part)) return `[inline_data mimeType=${part.inlineData.mimeType} name=${part.inlineData.name ?? ''} bytes=${part.inlineData.data?.length ?? part.inlineData.sizeBytes ?? 0}]`;
  if (isFileDataPart(part)) return `[file_data uri=${part.fileData.uri} mimeType=${part.fileData.mimeType ?? 'unknown'}]`;
  if (isProviderContextPart(part)) return `[provider_context format=${part.providerContext.format} itemType=${part.providerContext.itemType ?? 'context'}]`;
  return '';
}

function renderPartForTokenEstimate(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${safeJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${safeJson(part.functionResponse.response)}`;
  if (isProviderContextPart(part)) return `[provider context] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  if (isInlineDataPart(part)) return `[inline data] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[file] ${part.fileData.uri}`;
  return '';
}

function textContent(text: string): MessageContent {
  return { role: 'user', parts: [{ text }] };
}

function compareMessages(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.id.localeCompare(right.id);
}

function uniqueMap<T extends { id: string }>(values: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) throw new Error(`${label} Stable ID conflict: ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function parseJson(value: string): unknown {
  try { return value ? JSON.parse(value) : {}; }
  catch { return value; }
}

function jsonPreview(value: unknown): string {
  return truncate(safeJson(value), MAX_JSON_PREVIEW_CHARS);
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

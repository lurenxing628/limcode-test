import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Conversation, Message } from '../../chat/components';
import { conversationMessages } from '../../chat/queries';
import { LlmEventType } from '../../llm/events';
import type { LlmCompactDonePayload, LlmCompactErrorPayload, LlmRetryPayload } from '../../llm/events';
import { LlmInvocation } from '../../llm/components';
import { CompressionBlock, CompressionBlockLlmInvocationLink, CompressionBlockSourceLink, CompressionContextVariant, RunCompressionBlockLink } from '../components';
import { CompressionEventType } from '../events';
import type { CompressionBlockRecord, ContentPart, MessageContent } from '../../../../../shared/protocol';
import { isFileDataPart, isFunctionCallPart, isFunctionResponsePart, isInlineDataPart, isProviderContextPart, isTextPart, isVisibleTextPart } from '../../../../../shared/protocol';
import { nextAuxiliaryId, stableIds } from '../../../../reliability/stableIdFactory';
import { projectModelContext, estimateModelContextTokens } from '../../../../modelContext/modelContextProjector';
import type { ModelContextProjection } from '../../../../modelContext/types';
import { applyCompressionResultAddenda } from '../../../../modelContext/compressionResult';
import { compressionProjectionIdentity, validateCompressionSourceGraph } from '../../../../modelContext/compressionSourceGraph';
import { compressionModelContextWorldFactsReads, modelContextCompressionFactsFromWorld } from '../../agentRun/modelContextWorldFacts';
import { despawnModelContextProjectionsForCompressionBlocks, spawnCompressionModelContextProjection } from '../../modelContext/bundles';
import { projectModelContextState } from '../../modelContext/stateProjection';
import {
  CompressionModelContextProjectionLink,
  ModelContextProjection as ModelContextProjectionComponent,
  ModelContextProjectionConversationLink,
  ModelContextProjectionSourceLink,
  RequestModelContextProjectionLink
} from '../../modelContext/components';

const COMPRESSION_WRITE_COMPONENTS = [
  CompressionBlock,
  CompressionBlockSourceLink,
  CompressionContextVariant,
  RunCompressionBlockLink,
  LlmInvocation,
  CompressionBlockLlmInvocationLink,
  ModelContextProjectionComponent,
  ModelContextProjectionConversationLink,
  ModelContextProjectionSourceLink,
  RequestModelContextProjectionLink,
  CompressionModelContextProjectionLink
] as const;
const COMPRESSION_READ_COMPONENTS = [...new Set([
  ...COMPRESSION_WRITE_COMPONENTS,
  ...(compressionModelContextWorldFactsReads.components ?? [])
])] as const;

const COMPRESSION_SYSTEM_EVENT_TYPES = new Set<string>([
  CompressionEventType.Create,
  CompressionEventType.Delete,
  CompressionEventType.Update,
  CompressionEventType.Regenerate,
  CompressionEventType.Disable,
  CompressionEventType.Enable,
  LlmEventType.RetryScheduled,
  LlmEventType.RetryStarted,
  LlmEventType.RetryCancelled,
  LlmEventType.RetryRecovered,
  LlmEventType.CompactDone,
  LlmEventType.CompactError
]);

export const CompressionSystem = defineSystem({
  name: 'CompressionSystem',
  shouldRun(ctx) {
    return ctx.events.some((event) => COMPRESSION_SYSTEM_EVENT_TYPES.has(event.type));
  },
  access: {
    reads: { components: COMPRESSION_READ_COMPONENTS },
    writes: { components: COMPRESSION_WRITE_COMPONENTS, mutationMode: 'update' },
    events: {
      read: [
        CompressionEventType.Create,
        CompressionEventType.Delete,
        CompressionEventType.Update,
        CompressionEventType.Regenerate,
        CompressionEventType.Disable,
        CompressionEventType.Enable,
        LlmEventType.RetryScheduled,
        LlmEventType.RetryStarted,
        LlmEventType.RetryCancelled,
        LlmEventType.RetryRecovered,
        LlmEventType.CompactDone,
        LlmEventType.CompactError
      ],
      emit: [CompressionEventType.Create]
    },
    resources: { read: [...(compressionModelContextWorldFactsReads.resources ?? [])] },
    effects: { emit: ['llm.compact', 'llm.abort'] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, CompressionEventType.Delete)) deleteCompressionBlock(world, cmd, payload.blockId);
    for (const payload of readEvents(ctx, CompressionEventType.Disable)) setBlockDisabled(world, cmd, payload.blockId, true);
    for (const payload of readEvents(ctx, CompressionEventType.Enable)) setBlockDisabled(world, cmd, payload.blockId, false);
    for (const payload of readEvents(ctx, CompressionEventType.Update)) updateCompressionBlock(world, cmd, payload);
    for (const payload of readEvents(ctx, CompressionEventType.Regenerate)) regenerateCompressionBlock(world, cmd, payload.blockId, payload.conversationId, payload.methodConfigId);
    for (const payload of readEvents(ctx, CompressionEventType.Create)) createCompressionBlock(world, cmd, payload);
    for (const payload of readEvents(ctx, LlmEventType.RetryScheduled) as LlmRetryPayload[]) updateCompressionRetryState(world, cmd, payload, 'scheduled');
    for (const payload of readEvents(ctx, LlmEventType.RetryStarted) as LlmRetryPayload[]) updateCompressionRetryState(world, cmd, payload, 'retrying');
    for (const payload of readEvents(ctx, LlmEventType.RetryCancelled) as LlmRetryPayload[]) updateCompressionRetryState(world, cmd, payload, 'cancelled');
    for (const payload of readEvents(ctx, LlmEventType.RetryRecovered) as LlmRetryPayload[]) updateCompressionRetryState(world, cmd, payload, 'recovered');
    for (const payload of readEvents(ctx, LlmEventType.CompactDone) as LlmCompactDonePayload[]) completeCompressionBlock(world, cmd, payload);
    for (const payload of readEvents(ctx, LlmEventType.CompactError) as LlmCompactErrorPayload[]) failCompressionBlock(world, cmd, payload);
  }
});

interface CompressionSelection {
  projection: ModelContextProjection;
  selected: Entity[];
  requestContents: MessageContent[];
  startSeq: number;
  sourceMessageCount: number;
  anchor: { id: string; seq: number };
  segments?: MessageContent[][];
  priorSummaryContents?: MessageContent[];
  retainedBlock?: Entity;
}

function createCompressionBlock(
  world: WorldReader,
  cmd: CommandSink,
  payload: { conversationId: string; startMessageId?: string; endMessageId?: string; methodConfigId?: string; methodKind?: CompressionBlockRecord['methodKind']; trigger?: 'manual' | 'auto' }
): void {
  const conversation = findConversation(world, payload.conversationId);
  if (conversation === undefined) {
    debugAutoCompression('compression.create.skipConversationNotFound', { payload });
    return;
  }
  const methodKind = payload.methodKind ?? 'llm_summary';

  debugAutoCompression('compression.create.begin', {
    payload,
    conversation: describeConversation(world, conversation),
    methodKind,
    messages: describeConversationMessages(world, conversation)
  });

  const selection = prepareProjectedSelection(world, conversation, payload, methodKind);
  if (!selection) {
    debugAutoCompression('compression.create.skipNoSelection', {
      payload,
      conversation: describeConversation(world, conversation),
      methodKind
    });
    return;
  }

  debugAutoCompression('compression.create.selection', {
    payload,
    methodKind,
    selected: selection.selected.map((entity) => describeMessageEntity(world, entity)),
    requestContents: selection.requestContents.map(describeContent),
    startSeq: selection.startSeq,
    sourceMessageCount: selection.sourceMessageCount,
    anchor: selection.anchor,
    segmentCount: selection.segments?.length,
    segments: selection.segments?.map((segment) => segment.map(describeContent)),
    priorSummaryCount: selection.priorSummaryContents?.length,
    retainedBlock: selection.retainedBlock !== undefined ? world.get(selection.retainedBlock, CompressionBlock)?.id : undefined,
    projectionFingerprint: selection.projection.fingerprint,
    projectionDiagnostics: selection.projection.diagnostics
  });

  spawnCompressionBlock(world, cmd, conversation, methodKind, payload, selection);
}

function prepareProjectedSelection(
  world: WorldReader,
  conversation: Entity,
  payload: { startMessageId?: string; endMessageId?: string; trigger?: 'manual' | 'auto' },
  methodKind: CompressionBlockRecord['methodKind']
): CompressionSelection | undefined {
  const conversationRecord = world.get(conversation, Conversation);
  if (!conversationRecord) return undefined;
  const projection = projectModelContext({
    facts: modelContextCompressionFactsFromWorld(world),
    purpose: {
      kind: 'compression',
      mode: payload.trigger === 'auto' ? 'auto' : 'manual',
      conversationId: conversationRecord.id,
      ...(payload.startMessageId ? { startMessageId: payload.startMessageId } : {}),
      ...(payload.endMessageId ? { endMessageId: payload.endMessageId } : {}),
      methodKind
    }
  });
  if (projection.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return undefined;
  const compression = projection.compression;
  if (!compression?.anchorMessageId || compression.anchorSeq === undefined
    || compression.selectedMessageIds.length === 0 || projection.contents.length === 0) return undefined;
  const selected = compression.selectedMessageIds.flatMap((messageId) => {
    const entity = world.entityByRecordId(Message, messageId);
    return entity === undefined ? [] : [entity];
  });
  if (selected.length !== compression.selectedMessageIds.length) return undefined;
  const first = world.get(selected[0], Message);
  const anchor = world.get(selected[selected.length - 1], Message);
  if (!first || !anchor || anchor.id !== compression.anchorMessageId || anchor.seq !== compression.anchorSeq) return undefined;
  const retainedBlock = compression.priorBlockId
    ? world.entityByRecordId(CompressionBlock, compression.priorBlockId)
    : undefined;
  if (compression.priorBlockId && retainedBlock === undefined) return undefined;
  const predecessor = retainedBlock === undefined ? undefined : world.get(retainedBlock, CompressionBlock);
  return {
    projection,
    selected,
    requestContents: projection.contents.map(clone),
    startSeq: predecessor?.startSeq ?? first.seq,
    sourceMessageCount: Math.max(0, predecessor?.sourceMessageCount ?? 0) + selected.length,
    anchor: { id: anchor.id, seq: anchor.seq },
    ...(methodKind === 'segmented_summary' ? { segments: compression.segments.map((segment) => segment.map(clone)) } : {}),
    ...(compression.priorSummaryContents ? { priorSummaryContents: compression.priorSummaryContents.map(clone) } : {}),
    ...(retainedBlock !== undefined ? { retainedBlock } : {})
  };
}


function spawnCompressionBlock(
  world: WorldReader,
  cmd: CommandSink,
  conversation: Entity,
  methodKind: CompressionBlockRecord['methodKind'],
  payload: { conversationId: string; methodConfigId?: string; trigger?: 'manual' | 'auto' },
  selection: CompressionSelection
): void {
  const { selected, requestContents, anchor } = selection;
  const now = Date.now();
  const sourceHash = selection.projection.fingerprint;
  const tokenCountBefore = selection.projection.tokenCount;

  const block = cmd.spawn();
  const blockId = stableIds.nextCompressionId();
  const compactRequestId = stableIds.nextRequestId();
  debugAutoCompression('compression.spawnBlock', {
    blockId,
    compactRequestId,
    conversationId: payload.conversationId,
    methodKind,
    trigger: payload.trigger,
    anchor,
    startSeq: selection.startSeq,
    endSeq: anchor.seq,
    selected: selected.map((entity) => describeMessageEntity(world, entity)),
    tokenCountBefore
  });

  cmd.add(block, CompressionBlock, {
    id: blockId,
    conversation,
    title: payload.trigger === 'auto' ? '自动上下文压缩' : '上下文压缩',
    status: 'running',
    ...(payload.trigger ? { trigger: payload.trigger } : {}),
    methodKind,
    ...(payload.methodConfigId ? { methodConfigId: payload.methodConfigId } : {}),
    anchorMessageId: anchor.id,
    anchorSeq: anchor.seq,
    startSeq: selection.startSeq,
    endSeq: anchor.seq,
    sourceMessageCount: selection.sourceMessageCount,
    tokenCountBefore,
    sourceHash,
    createdAt: now,
    updatedAt: now
  });
  spawnCompressionModelContextProjection(world, cmd, {
    conversation,
    block,
    blockId,
    projection: selection.projection,
    now
  });

  let orderOffset = 0;
  if (selection.retainedBlock !== undefined) {
    const retained = world.get(selection.retainedBlock, CompressionBlock);
    if (retained) {
      const retainedLink = cmd.spawn();
      cmd.add(retainedLink, CompressionBlockSourceLink, {
        id: nextAuxiliaryId('csl'),
        block,
        source: selection.retainedBlock,
        sourceKind: 'compressionBlock',
        sourceId: retained.id,
        role: 'retained',
        order: 0,
        createdAt: now,
        updatedAt: now
      });
      orderOffset = 1;
    }
  }

  selected.forEach((messageEntity, index) => {
    const message = world.get(messageEntity, Message)!;
    const projected = selection.projection.messageSelections.find((candidate) => candidate.messageId === message.id);
    if (!projected) throw new Error(`Compression projection omitted selected Message ${message.id}.`);
    const link = cmd.spawn();
    cmd.add(link, CompressionBlockSourceLink, {
      id: nextAuxiliaryId('csl'),
      block,
      source: messageEntity,
      sourceKind: 'message',
      sourceId: message.id,
      revisionId: projected.revisionId,
      role: index === selected.length - 1 ? 'anchor' : 'source',
      order: index + orderOffset,
      createdAt: now,
      updatedAt: now
    });
  });

  const invocation = cmd.spawn();
  const invocationId = stableIds.nextInvocationId();
  cmd.add(invocation, LlmInvocation, {
    id: invocationId,
    requestId: compactRequestId,
    status: 'streaming',
    createdAt: now,
    startedAt: now
  });
  const invocationLink = cmd.spawn();
  cmd.add(invocationLink, CompressionBlockLlmInvocationLink, {
    id: nextAuxiliaryId('cil'),
    block,
    invocation,
    role: 'compact',
    createdAt: now,
    updatedAt: now
  });

  cmd.effect({
    kind: 'llm.compact',
    request: {
      id: compactRequestId,
      blockId,
      conversationId: payload.conversationId,
      invocationId,
      ...(payload.methodConfigId ? { methodConfigId: payload.methodConfigId } : {}),
      methodKind,
      contents: requestContents,
      ...(selection.segments ? { segments: selection.segments } : {}),
      ...(selection.priorSummaryContents ? { priorSummaryContents: selection.priorSummaryContents } : {}),
      sourceHash
    }
  });
}
function updateCompressionRetryState(
  world: WorldReader,
  cmd: CommandSink,
  payload: LlmRetryPayload,
  retryStatus: 'scheduled' | 'retrying' | 'cancelled' | 'recovered'
): void {
  const target = compressionInvocationByRequestId(world, payload.requestId);
  if (!target) return;
  const invocation = world.get(target.invocation, LlmInvocation);
  if (!invocation) return;
  const now = payload.createdAt ?? Date.now();
  cmd.add(target.invocation, LlmInvocation, {
    ...invocation,
    status: invocation.status === 'complete' || invocation.status === 'error' || invocation.status === 'cancelled' ? invocation.status : 'streaming',
    retryStatus,
    retryAttempt: payload.retryAttempt,
    retryMaxAttempts: payload.retryMaxAttempts,
    retryDelayMs: retryStatus === 'scheduled' ? payload.retryDelayMs : undefined,
    retryMessage: payload.message,
    ...(payload.rawError ? { retryRawError: payload.rawError } : invocation.retryRawError ? { retryRawError: invocation.retryRawError } : {}),
    retryUpdatedAt: now
  });

  const block = world.get(target.block, CompressionBlock);
  if (block && (retryStatus === 'scheduled' || retryStatus === 'retrying')) {
    cmd.add(target.block, CompressionBlock, { ...block, status: 'running', updatedAt: now });
  }
}

function compressionInvocationByRequestId(world: WorldReader, requestId: string): { invocation: Entity; block: Entity } | undefined {
  const invocations = world.query(LlmInvocation).filter((entity) => world.get(entity, LlmInvocation)?.requestId === requestId);
  if (invocations.length > 1) throw new Error(`Compression request has ambiguous Invocation ownership: ${requestId}`);
  const invocation = invocations[0];
  if (invocation === undefined) return undefined;
  const links = world
    .query(CompressionBlockLlmInvocationLink)
    .map((entity) => world.get(entity, CompressionBlockLlmInvocationLink))
    .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate && candidate.invocation === invocation);
  if (links.length > 1) throw new Error(`Compression Invocation has ambiguous block ownership: ${requestId}`);
  return links[0] ? { invocation, block: links[0].block } : undefined;
}



function completeCompressionBlock(world: WorldReader, cmd: CommandSink, payload: LlmCompactDonePayload): void {
  const blockEntity = findBlock(world, payload.blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  debugAutoCompression('compression.complete.event', {
    requestId: payload.requestId,
    blockId: payload.blockId,
    conversationId: payload.conversationId,
    found: blockEntity !== undefined && !!block,
    currentStatus: block?.status,
    resultContentCount: payload.result.contents.length,
    resultMethodKind: payload.result.methodConfig?.kind
  });
  if (blockEntity === undefined || !block || block.status !== 'running') return;
  const requestOwner = compressionInvocationByRequestId(world, payload.requestId);
  if (!requestOwner || requestOwner.block !== blockEntity) return;
  if (block.sourceHash && payload.result.methodConfig && payload.result.methodConfig.id === 'stale') {
    debugAutoCompression('compression.complete.skipStaleResult', { requestId: payload.requestId, blockId: payload.blockId });
    return;
  }
  const graph = compressionGraphViewFromWorld(world);
  const identity = compressionProjectionIdentity(graph, block.id);
  const validity = validateCompressionSourceGraph(graph, block.id);
  if (!identity || !validity.valid || identity.projection.fingerprint !== block.sourceHash) {
    const now = payload.completedAt;
    cmd.add(blockEntity, CompressionBlock, {
      ...block,
      status: 'stale',
      staleReason: `compression_source_invalid:${validity.reason ?? 'projection_identity_mismatch'}`,
      updatedAt: now,
      completedAt: now
    });
    failCompressionInvocation(world, cmd, blockEntity, {
      requestId: payload.requestId,
      blockId: payload.blockId,
      conversationId: payload.conversationId,
      message: `compression_source_invalid:${validity.reason ?? 'projection_identity_mismatch'}`,
      completedAt: now
    });
    return;
  }
  const now = payload.completedAt;
  const methodKind = payload.result.methodConfig?.kind ?? block.methodKind;
  const compactedContents = applyCompressionResultAddenda(payload.result.contents, identity.projection.resultAddenda);
  const tokenCountAfter = estimateModelContextTokens(compactedContents);
  const summaryPreview = previewFromContents(payload.result.contents) || block.summaryPreview;
  cmd.add(blockEntity, CompressionBlock, {
    ...block,
    status: 'complete',
    methodKind,
    ...(payload.result.methodConfig?.id ? { methodConfigId: payload.result.methodConfig.id } : block.methodConfigId ? { methodConfigId: block.methodConfigId } : {}),
    ...(summaryPreview ? { summaryPreview } : {}),
    tokenCountAfter,
    tokenSaved: block.tokenCountBefore !== undefined ? Math.max(0, block.tokenCountBefore - tokenCountAfter) : undefined,
    ...(payload.result.settingsSnapshot ? { providerSettingsSnapshot: clone(payload.result.settingsSnapshot) } : {}),
    ...(payload.result.methodConfig ? { compressionConfigSnapshot: clone(payload.result.methodConfig) } : {}),
    updatedAt: now,
    completedAt: now
  });
  completeCompressionInvocation(world, cmd, blockEntity, payload);
  const nativeVariant = cmd.spawn();
  const isNative = methodKind === 'provider_native';
  cmd.add(nativeVariant, CompressionContextVariant, {
    id: nextAuxiliaryId('cv'),
    block: blockEntity,
    kind: isNative ? 'provider_native' : 'provider_neutral_summary',
    contents: compactedContents,
    compatibility: isNative ? { provider: 'openai-responses', format: 'openai-responses', endpoint: 'responses.compact' } : undefined,
    ...(payload.result.usageMetadata ? { usageMetadata: payload.result.usageMetadata } : {}),
    ...(payload.result.rawResponse !== undefined ? { rawResponse: payload.result.rawResponse } : {}),
    createdAt: now,
    updatedAt: now
  });

  debugAutoCompression('compression.complete.apply', {
    requestId: payload.requestId,
    blockId: payload.blockId,
    previousStatus: block.status,
    nextStatus: 'complete',
    tokenCountAfter,
    tokenSaved: block.tokenCountBefore !== undefined ? Math.max(0, block.tokenCountBefore - tokenCountAfter) : undefined
  });
}

function failCompressionBlock(world: WorldReader, cmd: CommandSink, payload: LlmCompactErrorPayload): void {
  const blockEntity = findBlock(world, payload.blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  debugAutoCompression('compression.fail.event', {
    requestId: payload.requestId,
    blockId: payload.blockId,
    conversationId: payload.conversationId,
    found: blockEntity !== undefined && !!block,
    currentStatus: block?.status,
    message: payload.message
  });
  if (blockEntity === undefined || !block || block.status !== 'running') return;
  const requestOwner = compressionInvocationByRequestId(world, payload.requestId);
  if (!requestOwner || requestOwner.block !== blockEntity) return;
  cmd.add(blockEntity, CompressionBlock, { ...block, status: 'error', error: payload.message, updatedAt: payload.completedAt, completedAt: payload.completedAt });
  failCompressionInvocation(world, cmd, blockEntity, payload);
  debugAutoCompression('compression.fail.apply', {
    requestId: payload.requestId,
    blockId: payload.blockId,
    previousStatus: block.status,
    nextStatus: 'error',
    message: payload.message
  });
}

function completeCompressionInvocation(world: WorldReader, cmd: CommandSink, block: Entity, payload: LlmCompactDonePayload): void {
  const invocationEntity = compressionInvocationForBlock(world, block);
  const invocation = invocationEntity !== undefined ? world.get(invocationEntity, LlmInvocation) : undefined;
  if (invocationEntity === undefined || !invocation) return;
  const now = payload.completedAt;
  cmd.add(invocationEntity, LlmInvocation, {
    ...invocation,
    status: 'complete',
    ...(payload.result.settingsSnapshot ? { settings: payload.result.settingsSnapshot, resolvedAt: invocation.resolvedAt ?? invocation.startedAt ?? invocation.createdAt } : {}),
    ...(payload.result.usageMetadata ? { usageMetadata: payload.result.usageMetadata } : {}),
    completedAt: now
  });
}

function failCompressionInvocation(world: WorldReader, cmd: CommandSink, block: Entity, payload: LlmCompactErrorPayload): void {
  const invocationEntity = compressionInvocationForBlock(world, block);
  const invocation = invocationEntity !== undefined ? world.get(invocationEntity, LlmInvocation) : undefined;
  if (invocationEntity === undefined || !invocation) return;
  const retryStatus = invocation.retryStatus === 'cancelled'
    ? 'cancelled'
    : payload.retryAttempt !== undefined && payload.retryAttempt > 0 ? 'exhausted' : invocation.retryStatus;
  cmd.add(invocationEntity, LlmInvocation, {
    ...invocation,
    status: 'error',
    error: payload.message,
    ...(retryStatus ? { retryStatus } : {}),
    ...(payload.retryAttempt !== undefined ? { retryAttempt: payload.retryAttempt } : {}),
    ...(payload.retryMaxAttempts !== undefined ? { retryMaxAttempts: payload.retryMaxAttempts } : {}),
    retryDelayMs: undefined,
    retryMessage: payload.message,
    ...(payload.rawError ? { retryRawError: payload.rawError } : {}),
    retryUpdatedAt: payload.completedAt,
    completedAt: payload.completedAt
  });
}

function compressionInvocationForBlock(world: WorldReader, block: Entity): Entity | undefined {
  return world
    .query(CompressionBlockLlmInvocationLink)
    .map((entity) => world.get(entity, CompressionBlockLlmInvocationLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.block === block)
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]?.invocation;
}


function updateCompressionBlock(world: WorldReader, cmd: CommandSink, payload: { blockId: string; title?: string; summaryPreview?: string; summaryContents?: MessageContent[] }): void {
  const blockEntity = findBlock(world, payload.blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  if (blockEntity === undefined || !block) return;
  const now = Date.now();
  cmd.add(blockEntity, CompressionBlock, {
    ...block,
    ...(payload.title !== undefined ? { title: payload.title.trim() || block.title } : {}),
    ...(payload.summaryPreview !== undefined ? { summaryPreview: payload.summaryPreview } : {}),
    updatedAt: now
  });
  if (payload.summaryContents?.length) {
    const existing = world.query(CompressionContextVariant).find((entity) => {
      const variant = world.get(entity, CompressionContextVariant);
      return variant?.block === blockEntity && variant.kind === 'provider_neutral_summary';
    });
    if (existing !== undefined) {
      const variant = world.get(existing, CompressionContextVariant)!;
      cmd.add(existing, CompressionContextVariant, { ...variant, contents: payload.summaryContents, updatedAt: now });
    } else {
      const variant = cmd.spawn();
      cmd.add(variant, CompressionContextVariant, { id: nextAuxiliaryId('cv'), block: blockEntity, kind: 'provider_neutral_summary', contents: payload.summaryContents, createdAt: now, updatedAt: now });
    }
  }
}

function regenerateCompressionBlock(world: WorldReader, cmd: CommandSink, blockId: string, conversationId: string, methodConfigId?: string): void {
  const blockEntity = findBlock(world, blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  if (!block) return;
  const now = Date.now();
  cmd.add(blockEntity!, CompressionBlock, { ...block, status: 'stale', staleReason: '已重新生成新的压缩块。', updatedAt: now });
  cmd.enqueue({ type: CompressionEventType.Create, payload: { conversationId, endMessageId: block.anchorMessageId, ...(methodConfigId ? { methodConfigId } : block.methodConfigId ? { methodConfigId: block.methodConfigId } : {}), methodKind: block.methodKind, trigger: 'manual' } });
}

function setBlockDisabled(world: WorldReader, cmd: CommandSink, blockId: string, disabled: boolean): void {
  const blockEntity = findBlock(world, blockId);
  const block = blockEntity !== undefined ? world.get(blockEntity, CompressionBlock) : undefined;
  if (blockEntity === undefined || !block) return;
  const now = Date.now();
  cmd.add(blockEntity, CompressionBlock, { ...block, status: disabled ? 'disabled' : 'complete', updatedAt: now });
}

function deleteCompressionBlock(world: WorldReader, cmd: CommandSink, blockId: string): void {
  const root = findBlock(world, blockId);
  if (root === undefined) return;
  const blocks = dependentCompressionBlockClosure(world, root);
  despawnModelContextProjectionsForCompressionBlocks(world, cmd, blocks);
  for (const blockEntity of blocks) {
    const block = world.get(blockEntity, CompressionBlock);
    if (block?.status === 'pending' || block?.status === 'running') {
      const invocation = world.query(CompressionBlockLlmInvocationLink)
        .map((entity) => world.get(entity, CompressionBlockLlmInvocationLink))
        .find((link) => link?.block === blockEntity)?.invocation;
      const requestId = invocation !== undefined ? world.get(invocation, LlmInvocation)?.requestId : undefined;
      if (requestId) cmd.effect({ kind: 'llm.abort', requestId });
    }
    for (const entity of world.query(CompressionBlockSourceLink)) if (world.get(entity, CompressionBlockSourceLink)?.block === blockEntity) cmd.despawn(entity);
    for (const entity of world.query(CompressionBlockLlmInvocationLink)) {
      const link = world.get(entity, CompressionBlockLlmInvocationLink);
      if (link?.block !== blockEntity) continue;
      cmd.despawn(link.invocation);
      cmd.despawn(entity);
    }
    for (const entity of world.query(CompressionContextVariant)) if (world.get(entity, CompressionContextVariant)?.block === blockEntity) cmd.despawn(entity);
    for (const entity of world.query(RunCompressionBlockLink)) if (world.get(entity, RunCompressionBlockLink)?.block === blockEntity) cmd.despawn(entity);
    cmd.despawn(blockEntity);
  }
}

function dependentCompressionBlockClosure(world: WorldReader, root: Entity): Set<Entity> {
  const result = new Set<Entity>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const sourceBlock = queue.shift()!;
    const sourceId = world.get(sourceBlock, CompressionBlock)?.id;
    for (const entity of world.query(CompressionBlockSourceLink)) {
      const link = world.get(entity, CompressionBlockSourceLink);
      if (link?.sourceKind !== 'compressionBlock' || link.source !== sourceBlock || result.has(link.block)) continue;
      result.add(link.block);
      queue.push(link.block);
    }
    if (!sourceId) continue;
    const dependentProjections = new Set(world.query(ModelContextProjectionSourceLink).flatMap((entity) => {
      const source = world.get(entity, ModelContextProjectionSourceLink);
      return source?.sourceKind === 'compressionVariant' && source.blockId === sourceId ? [source.projection] : [];
    }));
    for (const entity of world.query(CompressionModelContextProjectionLink)) {
      const link = world.get(entity, CompressionModelContextProjectionLink);
      if (!link || !dependentProjections.has(link.projection) || result.has(link.block)) continue;
      result.add(link.block);
      queue.push(link.block);
    }
  }
  return result;
}


function compressionGraphViewFromWorld(world: WorldReader) {
  const graph = projectModelContextState(world);
  return {
    facts: modelContextCompressionFactsFromWorld(world),
    projections: graph.modelContextProjections ?? [],
    sourceLinks: graph.modelContextProjectionSourceLinks ?? [],
    compressionLinks: graph.compressionModelContextProjectionLinks ?? []
  };
}

function findConversation(world: WorldReader, conversationId: string): Entity | undefined {
  return world.entityByRecordId(Conversation, conversationId);
}

function findBlock(world: WorldReader, blockId: string): Entity | undefined {
  return world.entityByRecordId(CompressionBlock, blockId);
}


function previewFromContents(contents: MessageContent[]): string | undefined {
  const text = contents.flatMap((content) => content.parts.map(renderPart)).join(' ').replace(/\s+/g, ' ').trim();
  return text ? (text.length > 240 ? `${text.slice(0, 239)}…` : text) : undefined;
}

function renderPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${safeJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${safeJson(part.functionResponse.response)}`;
  if (isInlineDataPart(part)) return `[inline data] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[file] ${part.fileData.uri}`;
  if (isProviderContextPart(part)) return `[provider context] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  return '';
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function debugAutoCompression(stage: string, payload: Record<string, unknown>): void {
  const log = /skip|fail|error/i.test(stage) ? console.warn : console.info;
  log('[LimCode][Compression][System]', stage, sanitizeDebugValue(payload));
}

function sanitizeDebugValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const maxItems = 30;
    const items = value.slice(0, maxItems).map((item) => sanitizeDebugValue(item, depth + 1));
    return value.length > maxItems ? [...items, { omittedItems: value.length - maxItems }] : items;
  }
  if (depth >= 4) return '[Object]';
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sanitizeDebugValue(item, depth + 1);
  }
  return result;
}

function describeConversation(world: WorldReader, conversation: Entity): Record<string, unknown> | undefined {
  const data = world.get(conversation, Conversation);
  return data ? { entity: conversation, id: data.id, title: data.title } : undefined;
}

function describeConversationMessages(world: WorldReader, conversation: Entity): Array<Record<string, unknown> | undefined> {
  return conversationMessages(world, conversation).map((entity) => describeMessageEntity(world, entity));
}

function describeMessageEntity(world: WorldReader, entity: Entity): Record<string, unknown> | undefined {
  const message = world.get(entity, Message);
  return message ? describeMessageData(message) : undefined;
}

function describeMessageData(message: MessageDataLike): Record<string, unknown> {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    status: message.status,
    partKinds: message.content.parts.map(describePartKind),
    visibleTextLength: message.content.parts
      .filter(isVisibleTextPart)
      .reduce((total, part) => total + ('text' in part ? part.text.length : 0), 0)
  };
}

interface MessageDataLike {
  id: string;
  seq: number;
  role: string;
  status: string;
  content: MessageContent;
}

function describeContent(content: MessageContent): Record<string, unknown> {
  return {
    role: content.role,
    partKinds: content.parts.map(describePartKind),
    visibleTextLength: content.parts
      .filter(isVisibleTextPart)
      .reduce((total, part) => total + ('text' in part ? part.text.length : 0), 0)
  };
}

function describePartKind(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? 'thoughtText' : 'text';
  if (isFunctionCallPart(part)) return `functionCall:${part.functionCall.name}`;
  if (isFunctionResponsePart(part)) return `functionResponse:${part.functionResponse.name}`;
  if (isProviderContextPart(part)) return `providerContext:${part.providerContext.itemType ?? part.providerContext.format}`;
  if (isInlineDataPart(part)) return `inlineData:${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `fileData:${part.fileData.mimeType ?? 'unknown'}`;
  return Object.keys(part)[0] ?? 'unknown';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

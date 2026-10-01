import type { Content, LLMStreamChunk, Part } from 'unified-llm-provider';
import type {
  AssistantMessagePhase,
  ModelOutputItemReference
} from '../../shared/protocol';

export interface OpenAIResponsesContinuationProjectionResult {
  chunk: LLMStreamChunk;
  semanticOutput: boolean;
}

export interface OpenAIResponsesCompletedProjection {
  content: Content;
  outputItems: unknown[];
}

interface DoneOutputItem {
  item: Record<string, unknown>;
  outputIndex?: number;
  key: string;
}

interface TerminalOutputItem {
  item: Record<string, unknown>;
  outputIndex: number;
  trustedSignature?: string;
}

interface ProjectedFunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  async?: true;
}

interface ProjectedReasoningItem {
  key: string;
  itemId?: string;
  outputIndex?: number;
  text: string;
  trustedSignature?: string;
  summaryTextByIndex: Map<number, string>;
  completedSummaryIndexes: Set<number>;
  lastStreamedSummaryIndex?: number;
}

interface ProjectedMessageItem {
  key: string;
  itemId?: string;
  outputIndex?: number;
  text: string;
  phase?: AssistantMessagePhase;
}

/**
 * Builds the continuation baseline from the exact semantic chunks yielded to LimCode.
 *
 * Terminal items prove the semantic projection and provide ordered item boundaries, assistant phase
 * and the output_item.done reasoning signature. The baseline is rebuilt from those proven semantic
 * values rather than replaying provider terminal objects verbatim.
 */
export class OpenAIResponsesContinuationProjection {
  private thoughtText = '';
  private readonly functionCalls: ProjectedFunctionCall[] = [];
  private readonly functionCallIndexes = new Map<string, number>();
  private readonly doneItems: DoneOutputItem[] = [];
  private readonly doneItemIndexes = new Map<string, number>();
  private completedOutput?: Record<string, unknown>[];
  private readonly reasoningItems: ProjectedReasoningItem[] = [];
  private readonly reasoningItemsByKey = new Map<string, ProjectedReasoningItem>();
  private readonly messageItems: ProjectedMessageItem[] = [];
  private readonly messageItemsByKey = new Map<string, ProjectedMessageItem>();
  private unsafeReason?: string;

  public observe(
    raw: Record<string, unknown>,
    decoded: LLMStreamChunk
  ): OpenAIResponsesContinuationProjectionResult {
    this.captureTerminalEvidence(raw);
    this.captureMessageItemMetadata(raw);
    const canonical = this.canonicalChunk(raw, decoded);
    const chunk = this.withReasoningItemBoundary(raw, canonical);
    this.accumulateChunk(raw, chunk);
    if (eventType(raw) === 'response.output_item.done') {
      this.validateReasoningTerminal(raw);
      this.validateMessageTerminal(raw);
    }
    return { chunk, semanticOutput: hasSemanticChunkOutput(chunk) };
  }

  public completedProjection(): OpenAIResponsesCompletedProjection | undefined {
    if (this.unsafeReason) return undefined;
    const terminalItems = this.terminalItems();
    if (!terminalItems) return undefined;
    if (!this.validateTerminalProjection(terminalItems)) return undefined;
    return this.projectTerminalItems(terminalItems);
  }

  /**
   * Terminalizes a response that ended `response.incomplete` (for example reason=steered) from
   * done output items only. The server finished the current output item at the boundary; every
   * item must be proven exactly like the completed path (message/reasoning/function-call
   * provenance, signature preservation, contiguous output indexes). Any unproven item yields
   * undefined — nothing is fabricated. Meaningless once response.completed arrived (use
   * completedProjection); legacy callers are untouched.
   */
  public incompleteBoundaryProjection(): OpenAIResponsesCompletedProjection | undefined {
    if (this.unsafeReason) return undefined;
    if (this.completedOutput !== undefined) return undefined;
    const terminalItems = this.doneOnlyTerminalItems();
    if (!terminalItems) return undefined;
    if (!this.validateTerminalProjection(terminalItems)) return undefined;
    return this.projectTerminalItems(terminalItems);
  }

  private projectTerminalItems(
    terminalItems: TerminalOutputItem[]
  ): OpenAIResponsesCompletedProjection | undefined {
    if (terminalItems.length === 0) return { content: { role: 'model', parts: [] }, outputItems: [] };

    const parts: Part[] = [];
    const outputItems: unknown[] = [];
    for (const entry of terminalItems) {
      const outputItem = modelOutputItemReference(entry);
      if (entry.item.type === 'reasoning') {
        const reasoning = this.reasoningForTerminalItem(entry);
        if (!reasoning) return undefined;
        parts.push(withModelOutputItem({
          text: reasoning.text,
          thought: true,
          ...(reasoning.trustedSignature
            ? { thoughtSignatures: { 'openai-responses': reasoning.trustedSignature } }
            : {})
        }, outputItem));
        outputItems.push({
          type: 'reasoning',
          summary: reasoning.text ? [{ type: 'summary_text', text: reasoning.text }] : [],
          ...(reasoning.trustedSignature ? { encrypted_content: reasoning.trustedSignature } : {})
        });
        continue;
      }
      if (entry.item.type === 'message') {
        const message = this.messageForTerminalItem(entry);
        if (!message) return undefined;
        parts.push(withModelOutputItem({ text: message.text }, outputItem));
        outputItems.push({
          type: 'message',
          role: 'assistant',
          ...(message.phase ? { phase: message.phase } : {}),
          content: [{ type: 'output_text', text: message.text }]
        });
        continue;
      }
      if (entry.item.type === 'function_call') {
        const callId = optionalString(entry.item.call_id);
        const callIndex = callId ? this.functionCallIndexes.get(callId) : undefined;
        const call = callIndex === undefined ? undefined : this.functionCalls[callIndex];
        if (!call) return undefined;
        parts.push(withModelOutputItem({
          functionCall: {
            name: call.name,
            args: cloneJson(call.args),
            callId: call.callId,
            ...(call.async === true ? { async: true } : {})
          }
        }, outputItem));
        outputItems.push({
          type: 'function_call',
          call_id: call.callId,
          name: call.name,
          arguments: JSON.stringify(call.args),
          ...(call.async === true ? { async: true } : {})
        });
      }
    }

    if (parts.length === 0) return undefined;
    return { content: { role: 'model', parts }, outputItems };
  }

  private withReasoningItemBoundary(raw: Record<string, unknown>, decoded: LLMStreamChunk): LLMStreamChunk {
    if (eventType(raw) !== 'response.output_item.done'
      || !isRecord(raw.item)
      || raw.item.type !== 'reasoning') return decoded;
    const reasoning = this.reasoningItemForEvent(raw);
    if (!reasoning || reasoning.text || !this.thoughtText) return decoded;
    const text = (decoded.partsDelta ?? []).filter(isThoughtTextPart).map((part) => part.text ?? '').join('');
    return text ? withCanonicalThoughtText(decoded, `\n${text}`) : decoded;
  }

  private canonicalChunk(raw: Record<string, unknown>, decoded: LLMStreamChunk): LLMStreamChunk {
    const type = eventType(raw);
    const isDelta = isReasoningDeltaEvent(type);
    const isFullText = isReasoningFullTextEvent(type);
    if (!isDelta && !isFullText) return decoded;

    const rawText = isDelta
      ? optionalString(raw.delta)
      : reasoningFullText(raw, type);
    if (!rawText) return decoded;
    const reasoning = this.reasoningItemForEvent(raw);
    if (!reasoning) return decoded;
    const summaryIndex = nonNegativeInteger(raw.summary_index) ?? 0;
    const isNewBlock = !reasoning.summaryTextByIndex.has(summaryIndex);
    if (!this.registerSummaryBlock(reasoning, summaryIndex)) return decoded;

    const thoughtParts = (decoded.partsDelta ?? []).filter(isThoughtTextPart);
    const decodedText = thoughtParts.map((part) => part.text ?? '').join('');
    const existingText = reasoning.summaryTextByIndex.get(summaryIndex) ?? '';
    let rawProjectedText: string;
    if (isDelta) {
      if (reasoning.completedSummaryIndexes.has(summaryIndex)) {
        this.markUnsafe('reasoning_delta_after_summary_done');
      }
      if (decodedText !== rawText) this.markUnsafe('reasoning_delta_projection_changed');
      rawProjectedText = rawText;
      reasoning.summaryTextByIndex.set(summaryIndex, `${existingText}${rawText}`);
    } else {
      if (!rawText.startsWith(existingText)) {
        this.markUnsafe('reasoning_summary_terminal_revision_conflict');
        return withCanonicalThoughtText(decoded, '');
      }
      rawProjectedText = rawText.slice(existingText.length);
      reasoning.summaryTextByIndex.set(summaryIndex, rawText);
      if (isReasoningFullTextDoneEvent(type)) reasoning.completedSummaryIndexes.add(summaryIndex);
      if (decodedText && decodedText !== rawProjectedText && decodedText !== rawText) {
        this.markUnsafe('reasoning_full_text_projection_changed');
      }
    }

    if (isNewBlock && reasoning.text && rawProjectedText) reasoning.text += '\n';
    reasoning.text += rawProjectedText;
    let displayText = rawProjectedText;
    if (isNewBlock && this.thoughtText && displayText) displayText = `\n${displayText}`;
    return withCanonicalThoughtText(decoded, displayText);
  }

  private registerSummaryBlock(reasoning: ProjectedReasoningItem, summaryIndex: number): boolean {
    if (reasoning.summaryTextByIndex.has(summaryIndex)) {
      if (summaryIndex !== reasoning.lastStreamedSummaryIndex) {
        this.markUnsafe('reasoning_summary_blocks_out_of_order');
        return false;
      }
      return true;
    }
    const expectedIndex = reasoning.lastStreamedSummaryIndex === undefined
      ? 0
      : reasoning.lastStreamedSummaryIndex + 1;
    if (summaryIndex !== expectedIndex) {
      this.markUnsafe('reasoning_summary_index_gap');
      return false;
    }
    reasoning.summaryTextByIndex.set(summaryIndex, '');
    reasoning.lastStreamedSummaryIndex = summaryIndex;
    return true;
  }

  private accumulateChunk(raw: Record<string, unknown>, chunk: LLMStreamChunk): void {
    const parts = chunk.partsDelta ?? [];
    const visibleText = chunk.textDelta ?? parts.filter(isVisibleTextPart).map((part) => part.text ?? '').join('');
    if (visibleText) {
      const message = this.messageItemForEvent(raw);
      if (message) message.text += visibleText;
    }
    this.thoughtText += parts.filter(isThoughtTextPart).map((part) => part.text ?? '').join('');

    const signature = openAIResponsesSignature(chunk)
      ?? parts.map(openAIResponsesSignature).find((value): value is string => !!value);
    if (signature) {
      const trustedDoneSignature = eventType(raw) === 'response.output_item.done'
        && isRecord(raw.item)
        && raw.item.type === 'reasoning'
        && optionalString(raw.item.encrypted_content) === signature;
      const reasoning = this.reasoningItemForEvent(raw);
      if (!trustedDoneSignature || !reasoning) {
        this.markUnsafe('reasoning_signature_from_untrusted_event');
      } else if (reasoning.trustedSignature && reasoning.trustedSignature !== signature) {
        this.markUnsafe('reasoning_signature_conflict');
      } else reasoning.trustedSignature = signature;
    }

    const calls = [
      ...(chunk.functionCalls ?? []),
      ...parts.filter(isFunctionCallPart)
    ];
    for (const part of calls) this.accumulateFunctionCall(part);
  }

  private accumulateFunctionCall(part: Part): void {
    if (!isFunctionCallPart(part)) return;
    const callId = optionalString(part.functionCall.callId);
    if (!callId) {
      this.markUnsafe('function_call_without_provider_id');
      return;
    }
    const candidate: ProjectedFunctionCall = {
      callId,
      name: part.functionCall.name,
      args: cloneJson(part.functionCall.args),
      ...('async' in part.functionCall && part.functionCall.async === true ? { async: true as const } : {})
    };
    const existingIndex = this.functionCallIndexes.get(callId);
    if (existingIndex === undefined) {
      this.functionCallIndexes.set(callId, this.functionCalls.length);
      this.functionCalls.push(candidate);
      return;
    }
    if (canonicalString(this.functionCalls[existingIndex]) !== canonicalString(candidate)) {
      this.markUnsafe('function_call_projection_conflict');
    }
  }

  private captureMessageItemMetadata(raw: Record<string, unknown>): void {
    const type = eventType(raw);
    if ((type !== 'response.output_item.added' && type !== 'response.output_item.done')
      || !isRecord(raw.item) || raw.item.type !== 'message') return;
    const message = this.messageItemForEvent(raw);
    if (!message) return;
    const phase = assistantMessagePhase(raw.item.phase);
    if (message.phase && phase && message.phase !== phase) {
      this.markUnsafe('message_phase_conflict');
      return;
    }
    message.phase ??= phase;
  }

  private validateMessageTerminal(raw: Record<string, unknown>): void {
    if (!isRecord(raw.item) || raw.item.type !== 'message') return;
    const text = assistantMessageText(raw.item);
    if (text === undefined) {
      this.markUnsafe('message_terminal_content_invalid');
      return;
    }
    const message = this.messageItemForEvent(raw);
    if (!message) return;
    if (message.text && !text.startsWith(message.text)) {
      this.markUnsafe('message_terminal_revision_conflict');
      return;
    }
    const phase = assistantMessagePhase(raw.item.phase);
    if (message.phase && phase && message.phase !== phase) {
      this.markUnsafe('message_phase_conflict');
      return;
    }
    message.text = text;
    message.phase ??= phase;
  }

  private captureTerminalEvidence(raw: Record<string, unknown>): void {
    const type = eventType(raw);
    if (type === 'response.output_item.done') {
      if (!isRecord(raw.item)) {
        this.markUnsafe('output_item_done_without_item');
        return;
      }
      const outputIndex = nonNegativeInteger(raw.output_index);
      const key = optionalString(raw.item.id)
        ? `id:${optionalString(raw.item.id)}`
        : outputIndex !== undefined
          ? `output:${outputIndex}`
          : `ordinal:${this.doneItems.length}`;
      const candidate: DoneOutputItem = {
        item: cloneJson(raw.item),
        ...(outputIndex !== undefined ? { outputIndex } : {}),
        key
      };
      const existingIndex = this.doneItemIndexes.get(key);
      if (existingIndex === undefined) {
        this.doneItemIndexes.set(key, this.doneItems.length);
        this.doneItems.push(candidate);
      } else if (canonicalString(this.doneItems[existingIndex]) !== canonicalString(candidate)) {
        this.markUnsafe('output_item_done_conflict');
      }
      if (raw.item.type === 'reasoning' && !this.reasoningItemForEvent(raw)) {
        this.markUnsafe('reasoning_item_without_identity');
      }
      return;
    }
    if (type !== 'response.completed') return;
    const response = isRecord(raw.response) ? raw.response : raw;
    if (this.completedOutput !== undefined) {
      this.markUnsafe('duplicate_response_completed');
      return;
    }
    if (response.output === undefined) {
      this.completedOutput = [];
      return;
    }
    if (!Array.isArray(response.output)) {
      this.markUnsafe('response_completed_without_output_membership');
      return;
    }
    if (!response.output.every(isRecord)) {
      this.markUnsafe('response_completed_invalid_output_member');
      return;
    }
    this.completedOutput = response.output.map((item) => cloneJson(item));
  }

  private validateReasoningTerminal(raw: Record<string, unknown>): void {
    if (!isRecord(raw.item) || raw.item.type !== 'reasoning') return;
    const summary = reasoningSummaryText(raw.item.summary);
    if (summary === undefined) {
      this.markUnsafe('reasoning_terminal_summary_invalid');
      return;
    }
    const reasoning = this.reasoningItemForEvent(raw);
    if (!reasoning) return;
    if (reasoning.text && !summary.startsWith(reasoning.text)) {
      this.markUnsafe('reasoning_terminal_revision_conflict');
      return;
    }
    reasoning.text = summary;
  }

  private terminalItems(): TerminalOutputItem[] | undefined {
    if (this.completedOutput === undefined) return undefined;
    if (this.completedOutput.length === 0) return this.doneOnlyTerminalItems();

    const consumed = new Set<number>();
    const result: TerminalOutputItem[] = [];
    for (const [outputIndex, item] of this.completedOutput.entries()) {
      const matches = this.doneItems
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry, index }) => !consumed.has(index) && terminalItemsMatch(item, outputIndex, entry));
      if (matches.length > 1) return this.fail('completed_done_match_ambiguous');
      const matched = matches[0];
      if (matched) {
        consumed.add(matched.index);
        if (!sameTerminalItem(item, matched.entry.item)) return this.fail('completed_done_item_conflict');
      }
      result.push({
        item: cloneJson(item),
        outputIndex,
        ...(item.type === 'reasoning' && matched && optionalString(matched.entry.item.encrypted_content)
          ? { trustedSignature: optionalString(matched.entry.item.encrypted_content) }
          : {})
      });
    }
    if (consumed.size !== this.doneItems.length) return this.fail('completed_done_membership_conflict');
    return result;
  }

  /**
   * Terminal items proven solely by output_item.done evidence (no response.completed output
   * array): sorted, gap-free, and signature-preserving. Shared by the empty-output completed
   * path and the steered-incomplete boundary projection.
   */
  private doneOnlyTerminalItems(): TerminalOutputItem[] | undefined {
    const sorted = [...this.doneItems].sort((left, right) => {
      if (left.outputIndex === undefined || right.outputIndex === undefined) return 0;
      return left.outputIndex - right.outputIndex;
    });
    if (sorted.some((entry) => entry.outputIndex === undefined)) return this.fail('done_output_index_missing');
    for (let index = 0; index < sorted.length; index += 1) {
      if (sorted[index].outputIndex !== index) return this.fail('done_output_index_gap');
    }
    return sorted.map((entry) => ({
      item: cloneJson(entry.item),
      outputIndex: entry.outputIndex!,
      ...(entry.item.type === 'reasoning' && optionalString(entry.item.encrypted_content)
        ? { trustedSignature: optionalString(entry.item.encrypted_content) }
        : {})
    }));
  }

  private validateTerminalProjection(terminal: TerminalOutputItem[]): boolean {
    const reasoningEntries = terminal.filter((entry) => entry.item.type === 'reasoning');
    const messageEntries = terminal.filter((entry) => entry.item.type === 'message');
    const functionEntries = terminal.filter((entry) => entry.item.type === 'function_call');
    for (const entry of messageEntries) {
      if (!this.messageForTerminalItem(entry, true)) {
        return this.invalidate('message_terminal_content_invalid');
      }
    }
    if (reasoningEntries.length !== this.reasoningItems.length
      || messageEntries.length !== this.messageItems.length
      || functionEntries.length !== this.functionCalls.length
      || terminal.length !== reasoningEntries.length + messageEntries.length + functionEntries.length) {
      return this.invalidate('terminal_member_count_mismatch');
    }

    for (const entry of terminal) {
      if (entry.item.type === 'reasoning') {
        const reasoning = this.reasoningForTerminalItem(entry);
        const summary = reasoningSummaryText(entry.item.summary);
        if (!reasoning || summary === undefined || summary !== reasoning.text) {
          return this.invalidate('reasoning_terminal_revision_conflict');
        }
        if ((entry.trustedSignature ?? undefined) !== (reasoning.trustedSignature ?? undefined)) {
          return this.invalidate('reasoning_terminal_signature_conflict');
        }
        continue;
      }
      if (entry.item.type === 'message') {
        const text = assistantMessageText(entry.item);
        const phase = assistantMessagePhase(entry.item.phase);
        const message = this.messageForTerminalItem(entry);
        if (!message || text === undefined || (message.text && !text.startsWith(message.text))) {
          return this.invalidate('message_terminal_revision_conflict');
        }
        if (message.phase && phase && message.phase !== phase) {
          return this.invalidate('message_phase_conflict');
        }
        message.text = text;
        message.phase ??= phase;
        continue;
      }
      if (entry.item.type === 'function_call') {
        const callId = optionalString(entry.item.call_id);
        const callIndex = callId ? this.functionCallIndexes.get(callId) : undefined;
        const call = callIndex === undefined ? undefined : this.functionCalls[callIndex];
        if (!call || !sameFunctionCall(entry.item, call)) {
          return this.invalidate('function_call_terminal_conflict');
        }
        continue;
      }
      return this.invalidate('terminal_member_unrepresentable');
    }
    return !this.unsafeReason;
  }

  private messageItemForEvent(raw: Record<string, unknown>): ProjectedMessageItem | undefined {
    const identity = outputItemIdentity(raw);
    if (!identity) {
      this.markUnsafe('message_item_without_identity');
      return undefined;
    }
    const keys = outputItemIdentityKeys(identity);
    const matches = [...new Set(keys
      .map((key) => this.messageItemsByKey.get(key))
      .filter((item): item is ProjectedMessageItem => !!item))];
    if (matches.length > 1) {
      this.markUnsafe('message_identity_conflict');
      return undefined;
    }
    const existing = matches[0];
    if (existing) {
      if ((existing.itemId && identity.itemId && existing.itemId !== identity.itemId)
        || (existing.outputIndex !== undefined && identity.outputIndex !== undefined
          && existing.outputIndex !== identity.outputIndex)) {
        this.markUnsafe('message_identity_conflict');
        return undefined;
      }
      existing.itemId ??= identity.itemId;
      existing.outputIndex ??= identity.outputIndex;
      for (const key of keys) this.messageItemsByKey.set(key, existing);
      return existing;
    }

    const item: ProjectedMessageItem = {
      key: keys[0],
      ...(identity.itemId ? { itemId: identity.itemId } : {}),
      ...(identity.outputIndex !== undefined ? { outputIndex: identity.outputIndex } : {}),
      text: ''
    };
    this.messageItems.push(item);
    for (const key of keys) this.messageItemsByKey.set(key, item);
    return item;
  }

  private messageForTerminalItem(
    entry: TerminalOutputItem,
    hydrate = false
  ): ProjectedMessageItem | undefined {
    const itemId = optionalString(entry.item.id);
    const existing = (itemId ? this.messageItemsByKey.get(`id:${itemId}`) : undefined)
      ?? this.messageItemsByKey.get(`output:${entry.outputIndex}`);
    if (existing || !hydrate) return existing;
    const text = assistantMessageText(entry.item);
    if (text === undefined) return undefined;
    const item: ProjectedMessageItem = {
      key: itemId ? `id:${itemId}` : `output:${entry.outputIndex}`,
      ...(itemId ? { itemId } : {}),
      outputIndex: entry.outputIndex,
      text,
      ...(assistantMessagePhase(entry.item.phase)
        ? { phase: assistantMessagePhase(entry.item.phase) }
        : {})
    };
    this.messageItems.push(item);
    if (itemId) this.messageItemsByKey.set(`id:${itemId}`, item);
    this.messageItemsByKey.set(`output:${entry.outputIndex}`, item);
    return item;
  }

  private reasoningItemForEvent(raw: Record<string, unknown>): ProjectedReasoningItem | undefined {
    const identity = outputItemIdentity(raw);
    if (!identity) {
      this.markUnsafe('reasoning_item_without_identity');
      return undefined;
    }
    const keys = outputItemIdentityKeys(identity);
    const matches = [...new Set(keys
      .map((key) => this.reasoningItemsByKey.get(key))
      .filter((item): item is ProjectedReasoningItem => !!item))];
    if (matches.length > 1) {
      this.markUnsafe('reasoning_identity_conflict');
      return undefined;
    }
    const existing = matches[0];
    if (existing) {
      if ((existing.itemId && identity.itemId && existing.itemId !== identity.itemId)
        || (existing.outputIndex !== undefined && identity.outputIndex !== undefined
          && existing.outputIndex !== identity.outputIndex)) {
        this.markUnsafe('reasoning_identity_conflict');
        return undefined;
      }
      existing.itemId ??= identity.itemId;
      existing.outputIndex ??= identity.outputIndex;
      for (const key of keys) this.reasoningItemsByKey.set(key, existing);
      return existing;
    }

    const item: ProjectedReasoningItem = {
      key: keys[0],
      ...(identity.itemId ? { itemId: identity.itemId } : {}),
      ...(identity.outputIndex !== undefined ? { outputIndex: identity.outputIndex } : {}),
      text: '',
      summaryTextByIndex: new Map(),
      completedSummaryIndexes: new Set()
    };
    this.reasoningItems.push(item);
    for (const key of keys) this.reasoningItemsByKey.set(key, item);
    return item;
  }

  private reasoningForTerminalItem(entry: TerminalOutputItem): ProjectedReasoningItem | undefined {
    const itemId = optionalString(entry.item.id);
    return (itemId ? this.reasoningItemsByKey.get(`id:${itemId}`) : undefined)
      ?? this.reasoningItemsByKey.get(`output:${entry.outputIndex}`);
  }

  private markUnsafe(reason: string): void {
    this.unsafeReason ??= reason;
  }

  private invalidate(reason: string): false {
    this.markUnsafe(reason);
    return false;
  }

  private fail(reason: string): undefined {
    this.markUnsafe(reason);
    return undefined;
  }
}

export function hasSemanticChunkOutput(chunk: LLMStreamChunk): boolean {
  if (typeof chunk.textDelta === 'string' && chunk.textDelta.length > 0) return true;
  if ((chunk.functionCalls?.length ?? 0) > 0) return true;
  if (openAIResponsesSignature(chunk)) return true;
  return (chunk.partsDelta ?? []).some((part) => {
    if (isFunctionCallPart(part)) return true;
    if (isThoughtTextPart(part)) return !!part.text || !!openAIResponsesSignature(part);
    if (isVisibleTextPart(part)) return !!part.text;
    return isRecord(part) && 'providerContext' in part;
  });
}

function terminalItemsMatch(
  completed: Record<string, unknown>,
  completedIndex: number,
  done: DoneOutputItem
): boolean {
  const completedId = optionalString(completed.id);
  const doneId = optionalString(done.item.id);
  if (completedId && doneId) return completedId === doneId;
  return done.outputIndex === completedIndex && completed.type === done.item.type;
}

function sameTerminalItem(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonicalString(terminalComparable(left)) === canonicalString(terminalComparable(right));
}

function terminalComparable(value: Record<string, unknown>): Record<string, unknown> {
  const result = cloneJson(value);
  delete result.id;
  delete result.status;
  delete result.encrypted_content;
  return result;
}

function sameFunctionCall(item: Record<string, unknown>, call: ProjectedFunctionCall): boolean {
  if (optionalString(item.call_id) !== call.callId || optionalString(item.name) !== call.name) return false;
  if ((item.async === true) !== (call.async === true)) return false;
  let args: unknown = item.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return false;
    }
  }
  return isRecord(args) && canonicalString(args) === canonicalString(call.args);
}

function modelOutputItemReference(entry: TerminalOutputItem): ModelOutputItemReference {
  const phase = entry.item.type === 'message' ? assistantMessagePhase(entry.item.phase) : undefined;
  return {
    id: optionalString(entry.item.id) ?? `output:${entry.outputIndex}`,
    ordinal: entry.outputIndex,
    ...(phase ? { phase } : {})
  };
}

function withModelOutputItem(part: Part, outputItem: ModelOutputItemReference): Part {
  return { ...part, outputItem } as unknown as Part;
}

function assistantMessagePhase(value: unknown): AssistantMessagePhase | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

function assistantMessageText(item: Record<string, unknown>): string | undefined {
  if (item.role !== 'assistant' || !Array.isArray(item.content)) return undefined;
  let text = '';
  for (const block of item.content) {
    if (!isRecord(block) || block.type !== 'output_text' || typeof block.text !== 'string') return undefined;
    text += block.text;
  }
  return text;
}

function reasoningSummaryText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const blocks: string[] = [];
  for (const part of value) {
    const text = reasoningSummaryPartText(part);
    if (text) blocks.push(text);
  }
  return blocks.join('\n');
}

function reasoningSummaryPartText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.summary_text === 'string') return value.summary_text;
  if (typeof value.content === 'string') return value.content;
  return '';
}

function outputItemIdentity(value: Record<string, unknown>): { itemId?: string; outputIndex?: number } | undefined {
  const item = isRecord(value.item) ? value.item : undefined;
  const itemId = optionalString(value.item_id) ?? (item ? optionalString(item.id) : undefined);
  const outputIndex = nonNegativeInteger(value.output_index);
  return itemId || outputIndex !== undefined ? {
    ...(itemId ? { itemId } : {}),
    ...(outputIndex !== undefined ? { outputIndex } : {})
  } : undefined;
}

function outputItemIdentityKeys(identity: { itemId?: string; outputIndex?: number }): string[] {
  return [
    ...(identity.itemId ? [`id:${identity.itemId}`] : []),
    ...(identity.outputIndex !== undefined ? [`output:${identity.outputIndex}`] : [])
  ];
}

function isReasoningDeltaEvent(type: string): boolean {
  return type === 'response.reasoning_summary_text.delta'
    || type === 'response.reasoning_text.delta'
    || type === 'response.reasoning.delta';
}

function isReasoningFullTextEvent(type: string): boolean {
  return isReasoningFullTextDoneEvent(type)
    || type === 'response.reasoning_summary_part.added';
}

function isReasoningFullTextDoneEvent(type: string): boolean {
  return type === 'response.reasoning_summary_text.done'
    || type === 'response.reasoning_text.done'
    || type === 'response.reasoning.done'
    || type === 'response.reasoning_summary_part.done';
}

function reasoningFullText(raw: Record<string, unknown>, type: string): string | undefined {
  if (type === 'response.reasoning_summary_part.added'
    || type === 'response.reasoning_summary_part.done') {
    return optionalString(reasoningSummaryPartText(
      raw.part ?? raw.summary_part ?? raw.content_part ?? raw
    ));
  }
  return optionalString(raw.text)
    ?? optionalString(raw.content)
    ?? optionalString(raw.summary_text);
}

function withCanonicalThoughtText(chunk: LLMStreamChunk, text: string): LLMStreamChunk {
  const parts = chunk.partsDelta ?? [];
  const currentText = parts.filter(isThoughtTextPart).map((part) => part.text ?? '').join('');
  if (currentText === text) return chunk;

  let placedText = false;
  const projectedParts: Part[] = [];
  for (const part of parts) {
    if (!isThoughtTextPart(part) || typeof part.text !== 'string') {
      projectedParts.push(part);
      continue;
    }
    if (!placedText && text) {
      projectedParts.push({ ...part, text });
      placedText = true;
      continue;
    }
    const withoutText = { ...part } as Part & Record<string, unknown>;
    delete withoutText.text;
    if (Object.keys(withoutText).some((key) => key !== 'thought')) projectedParts.push(withoutText);
  }
  if (!placedText && text) projectedParts.push({ text, thought: true });
  return { ...chunk, partsDelta: projectedParts };
}

function isThoughtTextPart(value: unknown): value is Part & { text?: string; thought: true } {
  return isRecord(value) && value.thought === true;
}

function isVisibleTextPart(value: unknown): value is Part & { text?: string } {
  return isRecord(value) && 'text' in value && value.thought !== true;
}

function isFunctionCallPart(value: unknown): value is Part & {
  functionCall: { name: string; args: Record<string, unknown>; callId?: string };
} {
  return isRecord(value) && isRecord(value.functionCall)
    && typeof value.functionCall.name === 'string'
    && isRecord(value.functionCall.args);
}

function openAIResponsesSignature(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = optionalString(value.thoughtSignature);
  if (direct) {
    const prefix = 'openai-responses:';
    return direct.startsWith(prefix) ? direct.slice(prefix.length) : direct;
  }
  return isRecord(value.thoughtSignatures)
    ? optionalString(value.thoughtSignatures['openai-responses'])
    : undefined;
}

function eventType(value: Record<string, unknown>): string {
  return optionalString(value.event) ?? optionalString(value.type) ?? '';
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

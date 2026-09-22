import type { CollaborationBoard, CollaborationBoardArguments } from './collaborationBoard';
import type { ReliableAgentToolDispatchInput, ReliableAgentToolSettled } from './agentLoop';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import type { EffectControlPlane, ToolTerminalResult } from './effectControlPlane';
import { readFrozenTurnAuthority } from './frozenAuthority';
import { canonicalPlainJson, normalizePlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import type { ReliableToolDispatchAuthority } from './toolDispatcher';
import { isAgentCollaborationTool } from '../world/modules/tools/definitions/agentCollaboration';

/** The durable control planes own permission checks and mutation idempotency. */
export interface CollaborationToolControlPlane {
  listMembers(conversationId: string): Promise<unknown>;
  listMessages(input: { conversationId: string; targetConversationId?: string; afterMessageId?: string; beforeMessageId?: string; limit?: number }): Promise<unknown>;
  readConversation(input: { conversationId: string; targetConversationId: string; beforeMessageId?: string; limit?: number }): Promise<unknown>;
  readMessage(input: { conversationId: string; targetConversationId?: string; messageId: string }): Promise<unknown>;
  waitMessages(input: { conversationId: string; afterMessageId?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  send(input: { source: { kind: 'tool'; turnId: string; toolCallId: string }; targetConversationId: string;
    text: string; mode: 'message' | 'followup'; replyToMessageId?: string }): Promise<unknown>;
}

export interface CollaborationToolDispatcherDependencies {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  effects: EffectControlPlane;
  collaboration: CollaborationToolControlPlane;
  board?: Pick<CollaborationBoard, 'execute'>;
}

export class CollaborationToolDispatcher {
  public constructor(private readonly dependencies: CollaborationToolDispatcherDependencies) {}

  public async dispatch(input: ReliableAgentToolDispatchInput, signal?: AbortSignal,
    authority?: ReliableToolDispatchAuthority): Promise<ToolTerminalResult | ReliableAgentToolSettled | undefined> {
    if (!isAgentCollaborationTool(input.toolName) && input.toolName !== 'agent_board') return undefined;
    if (!authority) throw new Error('Collaboration tools require a frozen Turn authority.');
    const frozen = await readFrozenTurnAuthority(this.dependencies.database, this.dependencies.contentStore,
      authority.snapshotId, input.turnId);
    if (canonicalPlainJson(frozen.document) !== canonicalPlainJson(authority.document)) {
      throw new Error('Collaboration tool authority differs from the frozen snapshot.');
    }
    const policy = object(object(frozen.document, 'authority').toolPolicy, 'toolPolicy');
    if (!Array.isArray(policy.allowedTools) || !policy.allowedTools.includes(input.toolName)) {
      throw new Error(`Frozen ToolPolicy does not allow ${input.toolName}.`);
    }
    const read = await this.dependencies.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ToolCall').get(input.toolCallId),
      DOMAIN_REPOSITORIES.domain('ModelRequest').get(input.modelRequestId),
      DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({ where: { tool_call_id: input.toolCallId }, limit: 2 })
    ]);
    const call = read.snapshot[0]; const request = read.snapshot[1]; const links = read.snapshot[2];
    if (!call || Array.isArray(call) || call.turn_id !== input.turnId || call.tool_name !== input.toolName
      || !request || Array.isArray(request) || request.turn_id !== input.turnId
      || request.authority_snapshot_id !== authority.snapshotId
      || !Array.isArray(links) || links.length !== 1 || links[0].model_request_id !== input.modelRequestId) {
      throw new Error('Collaboration ToolCall source identity does not match its frozen request.');
    }
    const metadata = (await this.dependencies.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContentObject').get(text(call.arguments_object_id, 'ToolCall.arguments_object_id'))
    ])).snapshot[0];
    if (!metadata || Array.isArray(metadata)) throw new Error('Collaboration ToolCall arguments are missing.');
    const committedArguments = normalizePlainJson(JSON.parse((await this.dependencies.contentStore.read(
      metadata as unknown as ContentObjectMetadata)).toString('utf8')), 'Collaboration committed arguments');
    if (canonicalPlainJson(committedArguments) !== canonicalPlainJson(input.arguments)) {
      throw new Error('Collaboration tool arguments differ from the committed ToolCall.');
    }
    if (signal?.aborted) throw signal.reason ?? new Error('Collaboration tool was cancelled.');
    const args = object(input.arguments, `${input.toolName} arguments`);
    const conversationId = frozen.conversationId;
    let detail: unknown;
    switch (input.toolName) {
      case 'list_agents':
        fields(args, []);
        detail = await this.dependencies.collaboration.listMembers(conversationId);
        break;
      case 'send_agent_message': case 'followup_agent_task':
        fields(args, ['targetConversationId', 'text', 'replyToMessageId']);
        detail = await this.dependencies.collaboration.send({
          source: { kind: 'tool', turnId: input.turnId, toolCallId: input.toolCallId },
          targetConversationId: text(args.targetConversationId, 'conversationRef'), text: text(args.text, 'text'),
          mode: input.toolName === 'send_agent_message' ? 'message' : 'followup',
          ...(args.replyToMessageId === undefined ? {} : { replyToMessageId: text(args.replyToMessageId, 'replyToMessageRef') })
        });
        break;
      case 'read_agent_messages':
        fields(args, ['view', 'targetConversationId', 'messageId', 'afterMessageId', 'beforeMessageId', 'limit']);
        if (args.view !== undefined && args.view !== 'mailbox' && args.view !== 'conversation') throw new Error('Unknown message view.');
        if (args.view === 'conversation') {
          if (args.messageId !== undefined || args.afterMessageId !== undefined) throw new Error('Conversation history uses beforeMessageRef pagination only.');
          const result = object(await this.dependencies.collaboration.readConversation({ conversationId,
            targetConversationId: text(args.targetConversationId, 'conversationRef'),
            ...(args.beforeMessageId === undefined ? {} : { beforeMessageId: text(args.beforeMessageId, 'beforeMessageRef') }),
            limit: integer(args.limit, 'limit', 1, 50, 20) }), 'Conversation history');
          const { messages, olderMessageId, ...rest } = result;
          if (!Array.isArray(messages)) throw new Error('Conversation history messages are missing.');
          detail = { ...rest, view: 'conversation', olderConversationMessageId: olderMessageId,
            messages: messages.map(value => {
              const { messageId, ...message } = object(value, 'Conversation history message');
              return { ...message, conversationMessageId: messageId };
            }) };
        } else if (args.messageId !== undefined) {
          if (args.afterMessageId !== undefined || args.beforeMessageId !== undefined || args.limit !== undefined) throw new Error('messageRef cannot be combined with page arguments.');
          detail = await this.dependencies.collaboration.readMessage({ conversationId,
            ...(args.targetConversationId === undefined ? {} : { targetConversationId: text(args.targetConversationId, 'conversationRef') }), messageId: text(args.messageId, 'messageRef') });
        } else {
          if (args.afterMessageId !== undefined && args.beforeMessageId !== undefined) throw new Error('Use one message pagination direction.');
          detail = await this.dependencies.collaboration.listMessages({ conversationId,
            ...(args.targetConversationId === undefined ? {} : { targetConversationId: text(args.targetConversationId, 'conversationRef') }),
            ...(args.afterMessageId === undefined ? {} : { afterMessageId: text(args.afterMessageId, 'afterMessageRef') }),
            ...(args.beforeMessageId === undefined ? {} : { beforeMessageId: text(args.beforeMessageId, 'beforeMessageRef') }),
            limit: integer(args.limit, 'limit', 1, 100, 20) });
        }
        break;
      case 'wait_agent_messages':
        fields(args, ['afterMessageId', 'timeoutMs']);
        detail = await this.dependencies.collaboration.waitMessages({ conversationId, signal,
          ...(args.afterMessageId === undefined ? {} : { afterMessageId: text(args.afterMessageId, 'afterMessageRef') }),
          timeoutMs: integer(args.timeoutMs, 'timeoutMs', 0, 60000, 30000) });
        break;
      case 'agent_board':
        if (!this.dependencies.board) throw new Error('The collaboration board is not connected.');
        text(args.operation, 'agent_board.operation');
        detail = await this.dependencies.board.execute({ conversationId, turnId: input.turnId, toolCallId: input.toolCallId }, args as CollaborationBoardArguments);
        break;
    }
    if (input.toolName === 'read_agent_messages' || input.toolName === 'wait_agent_messages') {
      const result = object(detail, 'Collaboration message observation');
      if ('nextCursor' in result) {
        const { nextCursor, olderCursor, ...rest } = result;
        detail = { ...rest, nextAfterMessageId: nextCursor, ...(olderCursor === undefined ? {} : { olderMessageId: olderCursor }) };
      }
    }
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `collaboration-tool:${input.toolCallId}:result` },
      toolCallId: input.toolCallId, status: 'succeeded',
      detail: normalizePlainJson({ kind: 'agent_collaboration', ...object(detail, 'Collaboration tool result') }, 'Collaboration tool result')
    });
    return settled.terminal ?? { disposition: 'settled', toolCallId: input.toolCallId, status: settled.status };
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}
function fields(args: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new TypeError(`Unexpected collaboration argument: ${key}.`);
}
function integer(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

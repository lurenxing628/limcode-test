import { createHash } from 'node:crypto';
import { conversationAttachmentHandleLinkId } from './conversationAttachmentHandles';
import { TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION } from './nativeToolFacts';
import { NATIVE_STEER_MESSAGE_TURN_ROLE } from './nativeSteering';
import {
  isNativeRequest,
  readForkContextLineage,
  readNativeMessageContextRevisions,
  type NativeMessageContextRevision
} from './conversationForkContext';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryRead,
  type RepositoryTransactionStep
} from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export interface ConversationForkSnapshotPlan {
  assertions: RepositoryTransactionStep[];
  inserts: RepositoryTransactionStep[];
  copiedVisibleMessageCount: number;
}

interface MessageFact {
  message: DomainRow;
  membership: DomainRow;
  current: DomainRow;
  revision: DomainRow;
  attachments: DomainRow[];
  contextSources: DomainRow[];
  turnLinks: DomainRow[];
  requestLinks: DomainRow[];
  toolSources: DomainRow[];
}

interface RequestAggregate {
  request: DomainRow;
  operation: DomainRow;
  attempts: DomainRow[];
  fence: DomainRow | null;
}

interface ToolFact {
  toolCall: DomainRow;
  source: DomainRow;
  policy: DomainRow | null;
  events: DomainRow[];
  execution: DomainRow;
  outcome: DomainRow;
  artifacts: DomainRow[];
  modelResult: DomainRow;
  pairSources: DomainRow[];
  fileChangeSet: DomainRow | null;
  fileMembers: DomainRow[];
  fileDecision: DomainRow | null;
  interactionLinks: DomainRow[];
}

interface TurnRelations {
  termination: DomainRow | null;
  executor: DomainRow | null;
  messageLinks: DomainRow[];
  modelRequests: DomainRow[];
  toolCalls: DomainRow[];
  finalOutputFences: DomainRow[];
}

/**
 * Builds a frozen presentation snapshot for a Conversation fork. Immutable content and Context
 * nodes remain shared, while every Conversation-owned Message/Turn/request/tool identity is new.
 */
export async function prepareConversationForkSnapshot(
  database: RuntimeDatabase,
  input: {
    sourceConversationId: string;
    targetConversationId: string;
    boundaryMessageSeq?: bigint;
    /** Child forks select complete committed turns instead of a transcript prefix. */
    selectedMessageIds?: ReadonlySet<string>;
    contextSegmentIds?: readonly string[];
    targetAgentId: string;
    now: string;
  }
): Promise<ConversationForkSnapshotPlan> {
  if (input.boundaryMessageSeq === undefined) {
    return { assertions: [], inserts: [], copiedVisibleMessageCount: 0 };
  }

  const membershipBarrier = await database.snapshotAll(
    DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
      where: { conversation_id: input.sourceConversationId },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 1000
    })
  );
  const contextLineage = input.contextSegmentIds
    ? await readForkContextLineage(database, input.contextSegmentIds)
    : undefined;
  let boundaryMessageSeq = input.boundaryMessageSeq;
  if (contextLineage) {
    const membershipsByMessage = new Map(membershipBarrier.snapshot.map((membership) => [
      id(membership.message_id, 'MessagePartOfConversation.message_id'), membership
    ]));
    const revisionIds = unique(contextLineage.messageSources.map((source) => id(source.source_id, 'ContextSegmentSource.source_id')));
    const revisions = revisionIds.length > 0 ? await database.snapshot(revisionIds.map((revisionId) =>
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(revisionId)
    )) : null;
    const revisionsById = new Map<string, DomainRow>();
    for (const [index, revisionId] of revisionIds.entries()) {
      const value = revisions!.snapshot[index];
      if (value === null) continue;
      revisionsById.set(revisionId, row(value, `MessageRevision ${revisionId}`));
    }
    for (const source of contextLineage.messageSources) {
      const revision = revisionsById.get(id(source.source_id, 'ContextSegmentSource.source_id'));
      if (!revision) continue;
      const membership = membershipsByMessage.get(id(revision.message_id, 'MessageRevision.message_id'));
      if (!membership || (revision.role !== 'user' && revision.role !== 'model')) continue;
      if (source.source_revision !== revision.revision_seq
        || contextLineage.contentObjectIds.get(id(source.segment_id, 'ContextSegmentSource.segment_id')) !== revision.content_object_id) {
        throw new Error('Fork Context MessageRevision provenance is inconsistent.');
      }
      const sequence = integer(membership.message_seq, 'MessagePartOfConversation.message_seq');
      if (sequence > boundaryMessageSeq) boundaryMessageSeq = sequence;
    }
  }
  const prefixMemberships = membershipBarrier.snapshot
    .filter((row) => integer(row.message_seq, 'MessagePartOfConversation.message_seq') <= boundaryMessageSeq)
    .filter((row) => !input.selectedMessageIds || input.selectedMessageIds.has(id(row.message_id, 'MessagePartOfConversation.message_id')))
    .sort(compareMessageMembership);
  if (prefixMemberships.length === 0) {
    return { assertions: [], inserts: [], copiedVisibleMessageCount: 0 };
  }

  const basicReads = prefixMemberships.flatMap((membership): RepositoryRead[] => {
    const messageId = id(membership.message_id, 'MessagePartOfConversation.message_id');
    return [
      DOMAIN_REPOSITORIES.domain('Message').get(messageId),
      DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').list({
        where: { message_id: messageId },
        limit: 2
      })
    ];
  });
  const basic = await database.snapshot(basicReads);
  const messageCandidates: Array<{
    message: DomainRow;
    membership: DomainRow;
    current: DomainRow;
  }> = [];
  for (let index = 0; index < prefixMemberships.length; index += 1) {
    const membership = prefixMemberships[index];
    const messageId = id(membership.message_id, 'MessagePartOfConversation.message_id');
    const message = row(basic.snapshot[index * 2], `Message ${messageId}`);
    const currentRows = rows(basic.snapshot[index * 2 + 1], `MessageCurrentRevisionLink ${messageId}`);
    if (currentRows.length !== 1) throw new Error(`Fork source Message ${messageId} must have one current Revision.`);
    messageCandidates.push({ message, membership, current: currentRows[0] });
  }

  const revisionBarrier = await database.snapshot(messageCandidates.map((candidate) =>
    DOMAIN_REPOSITORIES.domain('MessageRevision').get(
      id(candidate.current.revision_id, 'MessageCurrentRevisionLink.revision_id')
    )
  ));
  const visibleCandidates = messageCandidates.flatMap((candidate, index) => {
    const revisionId = id(candidate.current.revision_id, 'MessageCurrentRevisionLink.revision_id');
    const revision = row(revisionBarrier.snapshot[index], `MessageRevision ${revisionId}`);
    if (revision.message_id !== candidate.message.id) {
      throw new Error(`Fork source current Revision ${revisionId} belongs to another Message.`);
    }
    return candidate.message.deleted_at === null && (revision.role === 'user' || revision.role === 'model')
      ? [{ ...candidate, revision }]
      : [];
  });

  const relationReads = visibleCandidates.flatMap((candidate): RepositoryRead[] => {
    const messageId = id(candidate.message.id, 'Message.id');
    const revisionId = id(candidate.revision.id, 'MessageRevision.id');
    return [
      DOMAIN_REPOSITORIES.domain('AttachmentLink').list({
        where: { message_revision_id: revisionId }, limit: 1000
      }),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'message_revision', source_id: revisionId }, limit: 1000
      }),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').list({ where: { message_id: messageId }, limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').list({ where: { message_id: messageId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({ where: { message_id: messageId }, limit: 1000 })
    ];
  });
  const relationBarrier = relationReads.length > 0 ? await database.snapshot(relationReads) : null;
  const messageFacts: MessageFact[] = [];
  for (const [index, candidate] of visibleCandidates.entries()) {
    const offset = index * 5;
    const fact: MessageFact = {
      ...candidate,
      attachments: rows(relationBarrier!.snapshot[offset], 'AttachmentLink fork source lookup'),
      contextSources: rows(relationBarrier!.snapshot[offset + 1], 'ContextSegmentSource fork source lookup'),
      turnLinks: rows(relationBarrier!.snapshot[offset + 2], 'MessageTurnLink fork source lookup'),
      requestLinks: rows(relationBarrier!.snapshot[offset + 3], 'ModelRequestMessageLink fork source lookup'),
      toolSources: rows(relationBarrier!.snapshot[offset + 4], 'ToolCallSourceLink fork source lookup')
    };
    if (fact.turnLinks.some((link) => link.role === NATIVE_STEER_MESSAGE_TURN_ROLE)) {
      if (!contextLineage) throw new Error('Native steering fork requires an explicit Context prefix.');
      if (!fact.contextSources.some((source) => contextLineage.segmentIds.has(id(source.segment_id, 'ContextSegmentSource.segment_id')))) {
        continue;
      }
    }
    messageFacts.push(fact);
  }

  const requestIds = unique(messageFacts.flatMap((fact) => [
    ...fact.requestLinks.map((link) => id(link.model_request_id, 'ModelRequestMessageLink.model_request_id')),
    ...fact.toolSources.map((link) => id(link.model_request_id, 'ToolCallSourceLink.model_request_id'))
  ]));
  const requestRows = await getRows(database, 'ModelRequest', requestIds);
  const requestAggregates = await readRequestAggregates(database, requestRows);
  const requestIdSet = new Set(requestAggregates.map((entry) => id(entry.request.id, 'ModelRequest.id')));
  const nativeRevisions = new Map<string, NativeMessageContextRevision[]>();
  const requestRowsById = new Map(requestRows.map((request) => [id(request.id, 'ModelRequest.id'), request]));
  for (const fact of messageFacts) {
    if (fact.revision.role !== 'model' || !fact.requestLinks.some((link) => {
      const request = requestRowsById.get(id(link.model_request_id, 'ModelRequestMessageLink.model_request_id'));
      return request && isNativeRequest(request);
    })) continue;
    if (!contextLineage) throw new Error('Native model output fork requires an explicit Context prefix.');
    const messageId = id(fact.message.id, 'Message.id');
    const revisions = await readNativeMessageContextRevisions(database, messageId);
    const additional: NativeMessageContextRevision[] = [];
    for (const revision of revisions) {
      if (revision.sources.some((source) => !contextLineage.segmentIds.has(id(source.segment_id, 'ContextSegmentSource.segment_id')))) {
        throw new Error('Fork boundary splits a native logical model message; select its completed message boundary.');
      }
      if (revision.revision.id !== fact.revision.id) additional.push(revision);
    }
    nativeRevisions.set(messageId, additional);
  }

  const toolSources = messageFacts
    .flatMap((fact) => fact.toolSources)
    .filter((source) => requestIdSet.has(id(source.model_request_id, 'ToolCallSourceLink.model_request_id')));
  const toolRows = await getRows(
    database,
    'ToolCall',
    unique(toolSources.map((source) => id(source.tool_call_id, 'ToolCallSourceLink.tool_call_id')))
  );
  const tools = await readToolFacts(database, toolSources, toolRows);
  if (contextLineage) {
    const included = contextLineage.segmentIds;
    for (const tool of tools) {
      if (!tool.events.some((event) => event.event_kind === TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION)) continue;
      if (tool.pairSources.some((source) => !included.has(id(source.segment_id, 'ContextSegmentSource.segment_id')))) {
        throw new Error('Fork boundary crosses a native response or excludes its tool result; choose a completed response boundary.');
      }
    }
  }
  const toolResultMessages = await readToolResultMessages(database, tools, input.sourceConversationId);

  const turnIds = unique([
    ...messageFacts.flatMap((fact) => fact.turnLinks.map((link) => id(link.turn_id, 'MessageTurnLink.turn_id'))),
    ...toolResultMessages.flatMap((fact) => fact.turnLinks.map((link) => id(link.turn_id, 'MessageTurnLink.turn_id'))),
    ...requestAggregates.map((entry) => id(entry.request.turn_id, 'ModelRequest.turn_id')),
    ...tools.map((entry) => id(entry.toolCall.turn_id, 'ToolCall.turn_id'))
  ]);
  const turnRows = await getRows(database, 'Turn', turnIds);
  const turnRelations = await readTurnRelations(database, turnRows);
  const fileFacts = await readFileFacts(database, tools);
  const interactionFacts = await readInteractionFacts(database, tools);

  const attachmentIds = new Set([...messageFacts, ...toolResultMessages].flatMap((fact) =>
    fact.attachments.map((link) => id(link.attachment_id, 'AttachmentLink.attachment_id'))
  ));
  for (const revisions of nativeRevisions.values()) {
    for (const revision of revisions) {
      for (const attachment of revision.attachments) attachmentIds.add(id(attachment.attachment_id, 'AttachmentLink.attachment_id'));
    }
  }
  const sourceAttachmentHandles = (await database.snapshotAll(
    DOMAIN_REPOSITORIES.domain('ConversationAttachmentHandleLink').list({
      where: { conversation_id: input.sourceConversationId },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 1000
    })
  )).snapshot.filter((link) => attachmentIds.has(
    id(link.attachment_id, 'ConversationAttachmentHandleLink.attachment_id')
  ));
  const handledAttachmentIds = new Set(sourceAttachmentHandles.map((link) =>
    id(link.attachment_id, 'ConversationAttachmentHandleLink.attachment_id')
  ));
  for (const attachmentId of attachmentIds) {
    if (!handledAttachmentIds.has(attachmentId)) {
      throw new Error(`Fork source Attachment ${attachmentId} has no stable Conversation handle.`);
    }
  }

  const target = input.targetConversationId;
  const messageIdMap = new Map<string, string>();
  const revisionIdMap = new Map<string, string>();
  for (const fact of [...messageFacts, ...toolResultMessages]) {
    const sourceMessageId = id(fact.message.id, 'Message.id');
    const sourceRevisionId = id(fact.revision.id, 'MessageRevision.id');
    messageIdMap.set(sourceMessageId, copyId(target, 'message', sourceMessageId));
    revisionIdMap.set(sourceRevisionId, copyId(target, 'message_revision', sourceRevisionId));
  }
  for (const revisions of nativeRevisions.values()) {
    for (const revision of revisions) {
      const revisionId = id(revision.revision.id, 'MessageRevision.id');
      revisionIdMap.set(revisionId, copyId(target, 'message_revision', revisionId));
    }
  }
  const turnIdMap = idMap(target, 'turn', turnIds);
  const requestIdMap = idMap(target, 'model_request', requestIds);
  const toolIdMap = idMap(target, 'tool_call', tools.map((fact) => id(fact.toolCall.id, 'ToolCall.id')));
  const modelResultIdMap = idMap(target, 'tool_model_result', tools.map((fact) => id(fact.modelResult.id, 'ToolModelResult.id')));

  const assertions: RepositoryTransactionStep[] = [];
  const inserts: RepositoryTransactionStep[] = [];
  const preservedTurnIds = new Set<string>();
  for (const handle of sourceAttachmentHandles) {
    const sourceHandleId = id(handle.id, 'ConversationAttachmentHandleLink.id');
    const attachmentId = id(handle.attachment_id, 'ConversationAttachmentHandleLink.attachment_id');
    assertions.push(DOMAIN_REPOSITORIES.domain('ConversationAttachmentHandleLink').assert(sourceHandleId, {
      conversation_id: input.sourceConversationId,
      attachment_id: attachmentId,
      handle_seq: handle.handle_seq
    }));
    inserts.push(DOMAIN_REPOSITORIES.domain('ConversationAttachmentHandleLink').insert({
      ...handle,
      id: conversationAttachmentHandleLinkId(target, attachmentId),
      conversation_id: target,
      attachment_id: attachmentId,
      created_at: input.now
    }));
  }
  for (const fact of messageFacts) addMessageCopy(assertions, inserts, fact, input, messageIdMap, revisionIdMap, turnIdMap);
  for (const fact of toolResultMessages) addMessageCopy(assertions, inserts, fact, input, messageIdMap, revisionIdMap, turnIdMap);
  for (const [messageId, revisions] of nativeRevisions) {
    const targetMessageId = mapped(messageIdMap, messageId, 'Message');
    for (const { revision, sources, attachments } of revisions) {
      const sourceRevisionId = id(revision.id, 'MessageRevision.id');
      const targetRevisionId = mapped(revisionIdMap, sourceRevisionId, 'MessageRevision');
      assertions.push(DOMAIN_REPOSITORIES.domain('MessageRevision').assert(sourceRevisionId, {
        message_id: messageId,
        revision_seq: revision.revision_seq,
        role: revision.role,
        content_object_id: revision.content_object_id
      }));
      inserts.push(DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        ...revision, id: targetRevisionId, message_id: targetMessageId
      }));
      for (const source of sources) {
        inserts.push(DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({
          ...source,
          id: copyId(target, 'context_segment_source', id(source.id, 'ContextSegmentSource.id')),
          source_id: targetRevisionId,
          source_revision: revision.revision_seq
        }));
      }
      for (const attachment of attachments) {
        inserts.push(DOMAIN_REPOSITORIES.domain('AttachmentLink').insert({
          ...attachment,
          id: copyId(target, 'attachment_link', id(attachment.id, 'AttachmentLink.id')),
          message_revision_id: targetRevisionId
        }));
      }
    }
  }

  for (const turn of turnRows) {
    const sourceTurnId = id(turn.id, 'Turn.id');
    const targetTurnId = mapped(turnIdMap, sourceTurnId, 'Turn');
    assertions.push(DOMAIN_REPOSITORIES.domain('Turn').assert(sourceTurnId, {
      conversation_id: input.sourceConversationId,
      status: turn.status
    }));
    inserts.unshift(DOMAIN_REPOSITORIES.domain('Turn').insert({
      ...turn,
      id: targetTurnId,
      conversation_id: target,
      status: 'terminated',
      updated_at: input.now,
      terminal_at: turn.terminal_at ?? input.now
    }));
    const relation = turnRelations.get(sourceTurnId);
    const preservesTerminalState = turn.status === 'terminated'
      && relation !== undefined
      && hasCompleteTurnClosure(relation, messageIdMap, requestIdMap, toolIdMap);
    if (preservesTerminalState && relation) {
      preservedTurnIds.add(sourceTurnId);
      assertions.push(
        DOMAIN_REPOSITORIES.domain('TurnTermination').assert(
          id(relation.termination!.id, 'TurnTermination.id'),
          { turn_id: sourceTurnId, terminal_status: relation.termination!.terminal_status }
        ),
        DOMAIN_REPOSITORIES.domain('MessageTurnLink').assertExactIds(
          { turn_id: sourceTurnId },
          relation.messageLinks.map((link) => id(link.id, 'MessageTurnLink.id'))
        ),
        DOMAIN_REPOSITORIES.domain('ModelRequest').assertExactIds(
          { turn_id: sourceTurnId },
          relation.modelRequests.map((request) => id(request.id, 'ModelRequest.id'))
        ),
        DOMAIN_REPOSITORIES.domain('ToolCall').assertExactIds(
          { turn_id: sourceTurnId },
          relation.toolCalls.map((tool) => id(tool.id, 'ToolCall.id'))
        ),
        DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assertExactIds(
          { turn_id: sourceTurnId },
          relation.finalOutputFences.map((fence) => id(fence.id, 'TurnFinalOutputFence.id'))
        )
      );
    }
    const termination = preservesTerminalState && relation ? relation.termination : null;
    inserts.push(DOMAIN_REPOSITORIES.domain('TurnTermination').insert(termination ? {
      ...termination,
      id: copyId(target, 'turn_termination', id(termination.id, 'TurnTermination.id')),
      turn_id: targetTurnId
    } : {
      id: copyId(target, 'turn_termination', sourceTurnId),
      turn_id: targetTurnId,
      terminal_status: 'interrupted',
      reason: 'forked_history_snapshot',
      created_at: input.now
    }));
    const executor = relation?.executor;
    inserts.push(DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert(executor ? {
      ...executor,
      id: copyId(target, 'turn_executor_link', id(executor.id, 'TurnExecutorLink.id')),
      turn_id: targetTurnId
    } : {
      id: copyId(target, 'turn_executor_link', sourceTurnId),
      turn_id: targetTurnId,
      agent_id: input.targetAgentId,
      created_at: input.now
    }));
  }

  for (const aggregate of requestAggregates) {
    addRequestAggregate(assertions, inserts, aggregate, target, turnIdMap, requestIdMap);
  }
  for (const fact of messageFacts) {
    for (const link of fact.requestLinks) {
      const sourceRequestId = id(link.model_request_id, 'ModelRequestMessageLink.model_request_id');
      if (!requestIdSet.has(sourceRequestId)) continue;
      inserts.push(DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').insert({
        ...link,
        id: copyId(target, 'model_request_message_link', id(link.id, 'ModelRequestMessageLink.id')),
        model_request_id: mapped(requestIdMap, sourceRequestId, 'ModelRequest'),
        message_id: mapped(messageIdMap, id(link.message_id, 'ModelRequestMessageLink.message_id'), 'Message')
      }));
    }
  }
  for (const sourceTurnId of preservedTurnIds) {
    for (const fence of turnRelations.get(sourceTurnId)?.finalOutputFences ?? []) {
      const sourceRequestId = id(fence.model_request_id, 'TurnFinalOutputFence.model_request_id');
      inserts.push(DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').insert({
        ...fence,
        id: copyId(target, 'turn_final_output_fence', id(fence.id, 'TurnFinalOutputFence.id')),
        turn_id: mapped(turnIdMap, sourceTurnId, 'Turn'),
        model_request_id: mapped(requestIdMap, sourceRequestId, 'ModelRequest')
      }));
    }
  }

  for (const tool of tools) {
    addToolCopy(assertions, inserts, tool, target, turnIdMap, requestIdMap, messageIdMap, revisionIdMap, toolIdMap, modelResultIdMap);
  }
  addFileCopies(inserts, fileFacts, target, toolIdMap);
  addInteractionCopies(inserts, interactionFacts, target, turnIdMap, toolIdMap);

  return {
    assertions,
    inserts,
    copiedVisibleMessageCount: messageFacts.length
  };
}

async function readRequestAggregates(database: RuntimeDatabase, requests: DomainRow[]): Promise<RequestAggregate[]> {
  if (requests.length === 0) return [];
  for (const request of requests) {
    if (request.status !== 'terminal') {
      throw new Error(`Fork source ModelRequest ${String(request.id)} is not terminal.`);
    }
  }
  const operationBarrier = await database.snapshot(requests.map((request) =>
    DOMAIN_REPOSITORIES.domain('Operation').list({
      where: { owner_kind: 'model_request', owner_id: id(request.id, 'ModelRequest.id') },
      limit: 2
    })
  ));
  const operations = requests.map((request, index) => {
    const found = rows(operationBarrier.snapshot[index], 'ModelRequest Operation fork lookup');
    if (found.length !== 1) throw new Error(`Fork source ModelRequest ${String(request.id)} must own one Operation.`);
    if (found[0].tool_call_id !== null) throw new Error('ModelRequest Operation unexpectedly references a ToolCall.');
    return found[0];
  });
  const aggregateBarrier = await database.snapshot(operations.flatMap((operation, index): RepositoryRead[] => [
    DOMAIN_REPOSITORIES.domain('Attempt').list({
      where: { operation_id: id(operation.id, 'Operation.id') }, limit: 1000
    }),
    DOMAIN_REPOSITORIES.domain('ModelStreamFence').list({
      where: { model_request_id: id(requests[index].id, 'ModelRequest.id') }, limit: 2
    })
  ]));
  return requests.map((request, index) => {
    const attempts = rows(aggregateBarrier.snapshot[index * 2], 'Attempt fork source lookup')
      .sort((left, right) => compareInteger(left.attempt_seq, right.attempt_seq));
    if (attempts.length === 0) throw new Error(`Fork source ModelRequest ${String(request.id)} has no Attempt.`);
    const fences = rows(aggregateBarrier.snapshot[index * 2 + 1], 'ModelStreamFence fork source lookup');
    if (fences.length > 1) throw new Error(`Fork source ModelRequest ${String(request.id)} has multiple fences.`);
    return { request, operation: operations[index], attempts, fence: fences[0] ?? null };
  });
}

async function readToolFacts(
  database: RuntimeDatabase,
  sources: DomainRow[],
  toolCalls: DomainRow[]
): Promise<ToolFact[]> {
  if (toolCalls.length === 0) return [];
  const sourceByTool = new Map(sources.map((source) => [id(source.tool_call_id, 'ToolCallSourceLink.tool_call_id'), source]));
  const reads = toolCalls.flatMap((tool): RepositoryRead[] => {
    const toolCallId = id(tool.id, 'ToolCall.id');
    if (tool.status !== 'terminal') throw new Error(`Fork source ToolCall ${toolCallId} is not terminal.`);
    return [
      DOMAIN_REPOSITORIES.domain('ToolCallPolicySnapshot').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ToolCallEvent').list({ where: { tool_call_id: toolCallId }, limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('ToolExecution').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ToolOutcome').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ToolResultArtifact').list({ where: { tool_call_id: toolCallId }, limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({ where: { source_kind: 'tool_call', source_id: toolCallId }, limit: 2 })
    ];
  });
  const barrier = await database.snapshot(reads);
  const partial = toolCalls.map((toolCall, index) => {
    const toolCallId = id(toolCall.id, 'ToolCall.id');
    const execution = one(rows(barrier.snapshot[index * 7 + 2], 'ToolExecution fork source lookup'), 'ToolExecution');
    const outcome = one(rows(barrier.snapshot[index * 7 + 3], 'ToolOutcome fork source lookup'), 'ToolOutcome');
    const modelResult = one(rows(barrier.snapshot[index * 7 + 5], 'ToolModelResult fork source lookup'), 'ToolModelResult');
    const callSources = rows(barrier.snapshot[index * 7 + 6], 'ToolCall Context source lookup');
    if (callSources.length !== 1) throw new Error(`Fork source ToolCall ${toolCallId} has no unique Context occurrence.`);
    return {
      toolCall,
      source: sourceByTool.get(toolCallId)!,
      policy: rows(barrier.snapshot[index * 7], 'ToolCallPolicySnapshot fork source lookup')[0] ?? null,
      events: rows(barrier.snapshot[index * 7 + 1], 'ToolCallEvent fork source lookup')
        .sort((left, right) => compareInteger(left.event_seq, right.event_seq)),
      execution,
      outcome,
      artifacts: rows(barrier.snapshot[index * 7 + 4], 'ToolResultArtifact fork source lookup'),
      modelResult,
      callSource: callSources[0]
    };
  });
  const resultSourceBarrier = await database.snapshot(partial.map((fact) =>
    DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
      where: {
        source_kind: 'tool_model_result',
        source_id: id(fact.modelResult.id, 'ToolModelResult.id')
      },
      limit: 2
    })
  ));
  return partial.map((fact, index) => {
    const resultSources = rows(resultSourceBarrier.snapshot[index], 'ToolModelResult Context source lookup');
    const native = fact.events.some((event) => event.event_kind === TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION);
    if (resultSources.length !== 1
      || compareInteger(resultSources[0].source_revision, fact.callSource.source_revision) !== 0
      || (!native && resultSources[0].segment_id !== fact.callSource.segment_id)) {
      throw new Error(`Fork source ToolCall ${String(fact.toolCall.id)} has an incomplete Context pair.`);
    }
    return { ...fact, pairSources: [fact.callSource, resultSources[0]], fileChangeSet: null, fileMembers: [], fileDecision: null, interactionLinks: [] };
  });
}

async function readToolResultMessages(
  database: RuntimeDatabase,
  tools: ToolFact[],
  sourceConversationId: string
): Promise<MessageFact[]> {
  if (tools.length === 0) return [];
  const revisions = await getRows(database, 'MessageRevision', tools.map((tool) =>
    id(tool.modelResult.message_revision_id, 'ToolModelResult.message_revision_id')
  ));
  const messageIds = revisions.map((revision) => id(revision.message_id, 'MessageRevision.message_id'));
  const reads = revisions.flatMap((revision): RepositoryRead[] => {
    const revisionId = id(revision.id, 'MessageRevision.id');
    const messageId = id(revision.message_id, 'MessageRevision.message_id');
    if (revision.role !== 'tool') throw new Error(`ToolModelResult Revision ${revisionId} must have tool role.`);
    return [
      DOMAIN_REPOSITORIES.domain('Message').get(messageId),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
        where: { conversation_id: sourceConversationId, message_id: messageId }, limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').list({ where: { message_id: messageId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('AttachmentLink').list({ where: { message_revision_id: revisionId }, limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').list({ where: { message_id: messageId }, limit: 1000 })
    ];
  });
  const barrier = await database.snapshot(reads);
  const byMessage = new Map<string, MessageFact>();
  revisions.forEach((revision, index) => {
    const messageId = messageIds[index];
    const message = row(barrier.snapshot[index * 5], `Tool result Message ${messageId}`);
    const membership = one(rows(barrier.snapshot[index * 5 + 1], 'Tool result membership lookup'), 'tool result membership');
    const current = one(rows(barrier.snapshot[index * 5 + 2], 'Tool result current Revision lookup'), 'tool result current Revision');
    if (current.revision_id !== revision.id) throw new Error(`Tool result Message ${messageId} current Revision changed.`);
    byMessage.set(messageId, {
      message,
      membership,
      current,
      revision,
      attachments: rows(barrier.snapshot[index * 5 + 3], 'Tool result AttachmentLink lookup'),
      contextSources: [],
      turnLinks: rows(barrier.snapshot[index * 5 + 4], 'Tool result MessageTurnLink lookup'),
      requestLinks: [],
      toolSources: []
    });
  });
  return [...byMessage.values()].sort((left, right) => compareMessageMembership(left.membership, right.membership));
}

async function readTurnRelations(database: RuntimeDatabase, turns: DomainRow[]): Promise<Map<string, TurnRelations>> {
  if (turns.length === 0) return new Map();
  const barrier = await database.snapshot(turns.flatMap((turn): RepositoryRead[] => {
    const turnId = id(turn.id, 'Turn.id');
    return [
      DOMAIN_REPOSITORIES.domain('TurnTermination').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').list({ where: { turn_id: turnId }, limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('ModelRequest').list({ where: { turn_id: turnId }, limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('ToolCall').list({ where: { turn_id: turnId }, limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').list({ where: { turn_id: turnId }, limit: 2 })
    ];
  }));
  return new Map(turns.map((turn, index) => {
    const turnId = id(turn.id, 'Turn.id');
    const offset = index * 6;
    const terminations = rows(barrier.snapshot[offset], 'TurnTermination fork lookup');
    const executors = rows(barrier.snapshot[offset + 1], 'TurnExecutorLink fork lookup');
    const finalOutputFences = rows(barrier.snapshot[offset + 5], 'TurnFinalOutputFence fork lookup');
    if (terminations.length > 1 || executors.length > 1 || finalOutputFences.length > 1) {
      throw new Error(`Fork source Turn ${turnId} has duplicate relations.`);
    }
    return [turnId, {
      termination: terminations[0] ?? null,
      executor: executors[0] ?? null,
      messageLinks: rows(barrier.snapshot[offset + 2], 'MessageTurnLink Turn closure lookup'),
      modelRequests: rows(barrier.snapshot[offset + 3], 'ModelRequest Turn closure lookup'),
      toolCalls: rows(barrier.snapshot[offset + 4], 'ToolCall Turn closure lookup'),
      finalOutputFences
    }];
  }));
}

function hasCompleteTurnClosure(
  relation: TurnRelations,
  messageIds: Map<string, string>,
  requestIds: Map<string, string>,
  toolIds: Map<string, string>
): boolean {
  if (!relation.termination) return false;
  const closureMapped = relation.messageLinks.every((link) =>
    messageIds.has(id(link.message_id, 'MessageTurnLink.message_id'))
  )
    && relation.modelRequests.every((request) => requestIds.has(id(request.id, 'ModelRequest.id')))
    && relation.toolCalls.every((tool) => toolIds.has(id(tool.id, 'ToolCall.id')));
  if (!closureMapped) return false;
  if (relation.termination.terminal_status !== 'completed') {
    return relation.finalOutputFences.length === 0;
  }
  if (relation.finalOutputFences.length !== 1) return false;
  return requestIds.has(id(
    relation.finalOutputFences[0].model_request_id,
    'TurnFinalOutputFence.model_request_id'
  ));
}

async function readFileFacts(database: RuntimeDatabase, tools: ToolFact[]): Promise<ToolFact[]> {
  if (tools.length === 0) return tools;
  const barrier = await database.snapshot(tools.map((tool) =>
    DOMAIN_REPOSITORIES.domain('FileChangeSet').list({
      where: { tool_call_id: id(tool.toolCall.id, 'ToolCall.id') }, limit: 2
    })
  ));
  const withSets = tools.map((tool, index) => {
    const sets = rows(barrier.snapshot[index], 'FileChangeSet fork lookup');
    if (sets.length > 1) throw new Error(`ToolCall ${String(tool.toolCall.id)} has duplicate FileChangeSets.`);
    return { ...tool, fileChangeSet: sets[0] ?? null };
  });
  const sets = withSets.flatMap((tool) => tool.fileChangeSet ? [tool.fileChangeSet] : []);
  if (sets.length === 0) return withSets;
  const detailBarrier = await database.snapshot(sets.flatMap((set): RepositoryRead[] => {
    const setId = id(set.id, 'FileChangeSet.id');
    return [
      DOMAIN_REPOSITORIES.domain('FileChangeSetMember').list({ where: { change_set_id: setId }, limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('FileChangeDecision').list({ where: { change_set_id: setId }, limit: 2 })
    ];
  }));
  const details = new Map(sets.map((set, index) => {
    const decisions = rows(detailBarrier.snapshot[index * 2 + 1], 'FileChangeDecision fork lookup');
    if (decisions.length > 1) throw new Error(`FileChangeSet ${String(set.id)} has duplicate decisions.`);
    return [id(set.id, 'FileChangeSet.id'), {
      members: rows(detailBarrier.snapshot[index * 2], 'FileChangeSetMember fork lookup'),
      decision: decisions[0] ?? null
    }];
  }));
  return withSets.map((tool) => {
    const detail = tool.fileChangeSet ? details.get(id(tool.fileChangeSet.id, 'FileChangeSet.id')) : undefined;
    return { ...tool, fileMembers: detail?.members ?? [], fileDecision: detail?.decision ?? null };
  });
}

async function readInteractionFacts(database: RuntimeDatabase, tools: ToolFact[]): Promise<{
  requests: DomainRow[];
  owners: DomainRow[];
  links: DomainRow[];
  responses: DomainRow[];
}> {
  if (tools.length === 0) return { requests: [], owners: [], links: [], responses: [] };
  const linkBarrier = await database.snapshot(tools.map((tool) =>
    DOMAIN_REPOSITORIES.domain('InteractionToolCallLink').list({
      where: { tool_call_id: id(tool.toolCall.id, 'ToolCall.id') }, limit: 1000
    })
  ));
  const links = linkBarrier.snapshot.flatMap((value) => rows(value, 'InteractionToolCallLink fork lookup'));
  const requestIds = unique(links.map((link) => id(link.request_id, 'InteractionToolCallLink.request_id')));
  if (requestIds.length === 0) return { requests: [], owners: [], links, responses: [] };
  const requests = await getRows(database, 'InteractionRequest', requestIds);
  const detailBarrier = await database.snapshot(requestIds.flatMap((requestId): RepositoryRead[] => [
    DOMAIN_REPOSITORIES.domain('InteractionOwnerLink').list({ where: { request_id: requestId }, limit: 2 }),
    DOMAIN_REPOSITORIES.domain('InteractionResponse').list({ where: { request_id: requestId }, limit: 2 })
  ]));
  return {
    requests,
    links,
    owners: requestIds.flatMap((_, index) => rows(detailBarrier.snapshot[index * 2], 'InteractionOwnerLink fork lookup')),
    responses: requestIds.flatMap((_, index) => rows(detailBarrier.snapshot[index * 2 + 1], 'InteractionResponse fork lookup'))
  };
}

function addMessageCopy(
  assertions: RepositoryTransactionStep[],
  inserts: RepositoryTransactionStep[],
  fact: MessageFact,
  input: { sourceConversationId: string; targetConversationId: string; now: string },
  messageIds: Map<string, string>,
  revisionIds: Map<string, string>,
  turnIds: Map<string, string>
): void {
  const sourceMessageId = id(fact.message.id, 'Message.id');
  const sourceRevisionId = id(fact.revision.id, 'MessageRevision.id');
  const targetMessageId = mapped(messageIds, sourceMessageId, 'Message');
  const targetRevisionId = mapped(revisionIds, sourceRevisionId, 'MessageRevision');
  assertions.push(
    DOMAIN_REPOSITORIES.domain('Message').assert(sourceMessageId, { deleted_at: fact.message.deleted_at }),
    DOMAIN_REPOSITORIES.domain('MessageRevision').assert(sourceRevisionId, {
      message_id: sourceMessageId,
      revision_seq: fact.revision.revision_seq,
      role: fact.revision.role,
      content_object_id: fact.revision.content_object_id
    }),
    DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(id(fact.current.id, 'MessageCurrentRevisionLink.id'), {
      message_id: sourceMessageId,
      revision_id: sourceRevisionId
    }),
    DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').assert(id(fact.membership.id, 'MessagePartOfConversation.id'), {
      conversation_id: input.sourceConversationId,
      message_id: sourceMessageId,
      message_seq: fact.membership.message_seq
    })
  );
  inserts.push(
    DOMAIN_REPOSITORIES.domain('Message').insert({
      ...fact.message,
      id: targetMessageId,
      deleted_at: null
    }),
    DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
      ...fact.revision,
      id: targetRevisionId,
      message_id: targetMessageId
    }),
    DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
      ...fact.current,
      id: copyId(input.targetConversationId, 'message_current_revision_link', id(fact.current.id, 'MessageCurrentRevisionLink.id')),
      message_id: targetMessageId,
      revision_id: targetRevisionId
    }),
    DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insert({
      ...fact.membership,
      id: copyId(input.targetConversationId, 'message_part_of_conversation', id(fact.membership.id, 'MessagePartOfConversation.id')),
      conversation_id: input.targetConversationId,
      message_id: targetMessageId
    })
  );
  for (const source of fact.contextSources) {
    inserts.push(DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({
      ...source,
      id: copyId(input.targetConversationId, 'context_segment_source', id(source.id, 'ContextSegmentSource.id')),
      source_id: targetRevisionId,
      source_revision: fact.revision.revision_seq
    }));
  }
  for (const attachment of fact.attachments) {
    inserts.push(DOMAIN_REPOSITORIES.domain('AttachmentLink').insert({
      ...attachment,
      id: copyId(input.targetConversationId, 'attachment_link', id(attachment.id, 'AttachmentLink.id')),
      message_revision_id: targetRevisionId
    }));
  }
  for (const link of fact.turnLinks) {
    const sourceTurnId = id(link.turn_id, 'MessageTurnLink.turn_id');
    inserts.push(DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
      ...link,
      id: copyId(input.targetConversationId, 'message_turn_link', id(link.id, 'MessageTurnLink.id')),
      turn_id: mapped(turnIds, sourceTurnId, 'Turn'),
      message_id: targetMessageId
    }));
  }
}

function addRequestAggregate(
  assertions: RepositoryTransactionStep[],
  inserts: RepositoryTransactionStep[],
  aggregate: RequestAggregate,
  target: string,
  turnIds: Map<string, string>,
  requestIds: Map<string, string>
): void {
  const sourceRequestId = id(aggregate.request.id, 'ModelRequest.id');
  const targetRequestId = mapped(requestIds, sourceRequestId, 'ModelRequest');
  assertions.push(DOMAIN_REPOSITORIES.domain('ModelRequest').assert(sourceRequestId, {
    turn_id: aggregate.request.turn_id,
    status: aggregate.request.status,
    terminal_state: aggregate.request.terminal_state
  }));
  inserts.push(DOMAIN_REPOSITORIES.domain('ModelRequest').insertHistoricalCopy({
    ...aggregate.request,
    id: targetRequestId,
    turn_id: mapped(turnIds, id(aggregate.request.turn_id, 'ModelRequest.turn_id'), 'Turn')
  }));
  const sourceOperationId = id(aggregate.operation.id, 'Operation.id');
  const targetOperationId = copyId(target, 'operation', sourceOperationId);
  inserts.push(DOMAIN_REPOSITORIES.domain('Operation').insertHistoricalCopy({
    ...aggregate.operation,
    id: targetOperationId,
    owner_id: targetRequestId
  }));
  for (const attempt of aggregate.attempts) {
    inserts.push(DOMAIN_REPOSITORIES.domain('Attempt').insertHistoricalCopy({
      ...attempt,
      id: copyId(target, 'attempt', id(attempt.id, 'Attempt.id')),
      operation_id: targetOperationId
    }));
  }
  if (aggregate.fence) {
    inserts.push(DOMAIN_REPOSITORIES.domain('ModelStreamFence').insertHistoricalCopy({
      ...aggregate.fence,
      id: copyId(target, 'model_stream_fence', id(aggregate.fence.id, 'ModelStreamFence.id')),
      model_request_id: targetRequestId
    }));
  }
}

function addToolCopy(
  assertions: RepositoryTransactionStep[],
  inserts: RepositoryTransactionStep[],
  fact: ToolFact,
  target: string,
  turnIds: Map<string, string>,
  requestIds: Map<string, string>,
  messageIds: Map<string, string>,
  revisionIds: Map<string, string>,
  toolIds: Map<string, string>,
  modelResultIds: Map<string, string>
): void {
  const sourceToolId = id(fact.toolCall.id, 'ToolCall.id');
  const targetToolId = mapped(toolIds, sourceToolId, 'ToolCall');
  const targetRequestId = mapped(requestIds, id(fact.source.model_request_id, 'ToolCallSourceLink.model_request_id'), 'ModelRequest');
  assertions.push(DOMAIN_REPOSITORIES.domain('ToolCall').assert(sourceToolId, {
    turn_id: fact.toolCall.turn_id,
    status: 'terminal'
  }));
  inserts.push(DOMAIN_REPOSITORIES.domain('ToolCall').insert({
    ...fact.toolCall,
    id: targetToolId,
    turn_id: mapped(turnIds, id(fact.toolCall.turn_id, 'ToolCall.turn_id'), 'Turn')
  }));
  inserts.push(DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').insert({
    ...fact.source,
    id: copyId(target, 'tool_call_source_link', id(fact.source.id, 'ToolCallSourceLink.id')),
    tool_call_id: targetToolId,
    model_request_id: targetRequestId,
    message_id: mapped(messageIds, id(fact.source.message_id, 'ToolCallSourceLink.message_id'), 'Message'),
    batch_id: copyId(target, 'tool_call_batch', id(fact.source.batch_id, 'ToolCallSourceLink.batch_id'))
  }));
  if (fact.policy) inserts.push(DOMAIN_REPOSITORIES.domain('ToolCallPolicySnapshot').insert({
    ...fact.policy,
    id: copyId(target, 'tool_call_policy_snapshot', id(fact.policy.id, 'ToolCallPolicySnapshot.id')),
    tool_call_id: targetToolId
  }));
  for (const event of fact.events) inserts.push(DOMAIN_REPOSITORIES.domain('ToolCallEvent').insert({
    ...event,
    id: copyId(target, 'tool_call_event', id(event.id, 'ToolCallEvent.id')),
    tool_call_id: targetToolId
  }));
  inserts.push(
    DOMAIN_REPOSITORIES.domain('ToolExecution').insert({
      ...fact.execution,
      id: copyId(target, 'tool_execution', id(fact.execution.id, 'ToolExecution.id')),
      tool_call_id: targetToolId
    }),
    DOMAIN_REPOSITORIES.domain('ToolOutcome').insert({
      ...fact.outcome,
      id: copyId(target, 'tool_outcome', id(fact.outcome.id, 'ToolOutcome.id')),
      tool_call_id: targetToolId
    })
  );
  for (const artifact of fact.artifacts) inserts.push(DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
    ...artifact,
    id: copyId(target, 'tool_result_artifact', id(artifact.id, 'ToolResultArtifact.id')),
    tool_call_id: targetToolId
  }));
  const sourceModelResultId = id(fact.modelResult.id, 'ToolModelResult.id');
  const targetModelResultId = mapped(modelResultIds, sourceModelResultId, 'ToolModelResult');
  inserts.push(DOMAIN_REPOSITORIES.domain('ToolModelResult').insert({
    ...fact.modelResult,
    id: targetModelResultId,
    tool_call_id: targetToolId,
    message_revision_id: mapped(
      revisionIds,
      id(fact.modelResult.message_revision_id, 'ToolModelResult.message_revision_id'),
      'MessageRevision'
    )
  }));
  for (const source of fact.pairSources) {
    const sourceKind = String(source.source_kind);
    inserts.push(DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({
      ...source,
      id: copyId(target, `context_${sourceKind}`, id(source.id, 'ContextSegmentSource.id')),
      source_id: sourceKind === 'tool_call' ? targetToolId : targetModelResultId,
      source_revision: fact.toolCall.call_seq
    }));
  }
}

function addFileCopies(inserts: RepositoryTransactionStep[], tools: ToolFact[], target: string, toolIds: Map<string, string>): void {
  for (const tool of tools) {
    if (!tool.fileChangeSet) continue;
    const sourceSetId = id(tool.fileChangeSet.id, 'FileChangeSet.id');
    const targetSetId = copyId(target, 'file_change_set', sourceSetId);
    inserts.push(DOMAIN_REPOSITORIES.domain('FileChangeSet').insert({
      ...tool.fileChangeSet,
      id: targetSetId,
      tool_call_id: mapped(toolIds, id(tool.toolCall.id, 'ToolCall.id'), 'ToolCall')
    }));
    for (const member of tool.fileMembers) inserts.push(DOMAIN_REPOSITORIES.domain('FileChangeSetMember').insert({
      ...member,
      id: copyId(target, 'file_change_set_member', id(member.id, 'FileChangeSetMember.id')),
      change_set_id: targetSetId
    }));
    if (tool.fileDecision) inserts.push(DOMAIN_REPOSITORIES.domain('FileChangeDecision').insert({
      ...tool.fileDecision,
      id: copyId(target, 'file_change_decision', id(tool.fileDecision.id, 'FileChangeDecision.id')),
      change_set_id: targetSetId
    }));
  }
}

function addInteractionCopies(
  inserts: RepositoryTransactionStep[],
  facts: { requests: DomainRow[]; owners: DomainRow[]; links: DomainRow[]; responses: DomainRow[] },
  target: string,
  turnIds: Map<string, string>,
  toolIds: Map<string, string>
): void {
  const requestIds = idMap(target, 'interaction_request', facts.requests.map((request) => id(request.id, 'InteractionRequest.id')));
  for (const request of facts.requests) inserts.push(DOMAIN_REPOSITORIES.domain('InteractionRequest').insert({
    ...request,
    id: mapped(requestIds, id(request.id, 'InteractionRequest.id'), 'InteractionRequest')
  }));
  for (const owner of facts.owners) inserts.push(DOMAIN_REPOSITORIES.domain('InteractionOwnerLink').insert({
    ...owner,
    id: copyId(target, 'interaction_owner_link', id(owner.id, 'InteractionOwnerLink.id')),
    request_id: mapped(requestIds, id(owner.request_id, 'InteractionOwnerLink.request_id'), 'InteractionRequest'),
    turn_id: mapped(turnIds, id(owner.turn_id, 'InteractionOwnerLink.turn_id'), 'Turn')
  }));
  for (const link of facts.links) inserts.push(DOMAIN_REPOSITORIES.domain('InteractionToolCallLink').insert({
    ...link,
    id: copyId(target, 'interaction_tool_call_link', id(link.id, 'InteractionToolCallLink.id')),
    request_id: mapped(requestIds, id(link.request_id, 'InteractionToolCallLink.request_id'), 'InteractionRequest'),
    tool_call_id: mapped(toolIds, id(link.tool_call_id, 'InteractionToolCallLink.tool_call_id'), 'ToolCall')
  }));
  for (const response of facts.responses) inserts.push(DOMAIN_REPOSITORIES.domain('InteractionResponse').insert({
    ...response,
    id: copyId(target, 'interaction_response', id(response.id, 'InteractionResponse.id')),
    request_id: mapped(requestIds, id(response.request_id, 'InteractionResponse.request_id'), 'InteractionRequest')
  }));
}

async function getRows(database: RuntimeDatabase, domain: string, ids: string[]): Promise<DomainRow[]> {
  if (ids.length === 0) return [];
  const barrier = await database.snapshot(ids.map((rowId) => DOMAIN_REPOSITORIES.domain(domain).get(rowId)));
  return ids.map((rowId, index) => row(barrier.snapshot[index], `${domain} ${rowId}`));
}

function idMap(target: string, kind: string, sourceIds: string[]): Map<string, string> {
  return new Map(sourceIds.map((sourceId) => [sourceId, copyId(target, kind, sourceId)]));
}

function mapped(values: Map<string, string>, sourceId: string, label: string): string {
  const value = values.get(sourceId);
  if (!value) throw new Error(`Fork snapshot omitted required ${label} ${sourceId}.`);
  return value;
}

function copyId(targetConversationId: string, kind: string, sourceId: string): string {
  return conversationForkSnapshotCopyId(targetConversationId, kind, sourceId);
}

export function conversationForkSnapshotCopyId(
  targetConversationId: string,
  kind: string,
  sourceId: string
): string {
  const digest = createHash('sha256')
    .update('limcode-conversation-fork-snapshot\0')
    .update(targetConversationId)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(sourceId)
    .digest('hex');
  return `${kind}_${digest}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function one(values: DomainRow[], label: string): DomainRow {
  if (values.length !== 1) throw new Error(`Fork source ${label} must be unique.`);
  return values[0];
}

function row(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function rows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} did not return rows.`);
  return value as DomainRow[];
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function integer(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an integer.`);
}

function compareInteger(left: unknown, right: unknown): number {
  const leftValue = integer(left, 'sequence');
  const rightValue = integer(right, 'sequence');
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function compareMessageMembership(left: DomainRow, right: DomainRow): number {
  return compareInteger(left.message_seq, right.message_seq)
    || id(left.message_id, 'MessagePartOfConversation.message_id')
      .localeCompare(id(right.message_id, 'MessagePartOfConversation.message_id'));
}

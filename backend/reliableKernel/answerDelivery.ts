import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import {
  AutomaticRuntimeDeliveryRouter,
  type AutomaticRuntimeDeliveryDecision
} from './automaticRuntimeDelivery';
import {
  ChildExecutionControlPlane,
  type ChildWaitSettlement,
  type PreparedForegroundSettlement
} from './childExecution';
import { requireChildExecutionStatus } from './childExecutionState';
import { isCrossConversationFollowup } from './collaborationScope';
import { displayConversationTitle } from '../../shared/conversationTitle';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  isTransactionAssertionFailure,
  requireIsoTimestamp,
  requirePhaseFId,
  requirePhaseFText,
  requirePositiveInteger,
  stablePhaseFId,
  sqliteUniqueFailureIncludes
} from './phaseFIdentity';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  projectRuntimeDeliveryForModel,
  runtimeDeliveryPhaseAllowsModelInput,
  type RuntimeDeliveryModelProjection
} from './runtimeDeliveryProjection';

export type RuntimeDeliveryPhase = 'current_turn' | 'next_turn' | 'notify_only';
export type RuntimeDeliveryState = 'pending' | 'consumed' | 'failed';
export type ParentHandlingState = 'unhandled' | 'handled' | 'not_applicable';

export interface AnswerSubmitCommand {
  answerBridgeId: string;
  submissionId: string;
  /** Exact Child Turn generation that owns this submission. */
  sourceTurnId: string;
  title?: string;
  content: string | Uint8Array;
  contentType?: string;
}

export interface AnswerSubmitResult {
  answerBridgeId: string;
  submissionId: string;
  answerPayloadId: string;
  inboxItemId: string;
  foregroundSettled: boolean;
  deduplicated: boolean;
  /** Exact historical callback replay; callers must not re-run wait/delivery orchestration. */
  historicalReplay: boolean;
  commitSeq?: string;
}

export interface AnswerWaitRecoveryResult {
  answerBridgeId: string;
  submissionId: string;
  inboxItemId: string;
  sourceTurnId: string;
  newlySettledToolCallIds: string[];
  settledByAnswer: boolean;
}

export type AnswerReadResult =
  | { status: 'not_found' }
  | { status: 'running'; answerBridgeId: string; childExecutionId: string }
  | { status: 'interrupted'; answerBridgeId: string; childExecutionId: string }
  | {
      status: 'failed';
      answerBridgeId: string;
      childExecutionId: string;
      submissionId: string;
      sourceTurnId: string;
      title: string | null;
      content: string;
      contentType: string;
    }
  | {
      status: 'submitted';
      answerBridgeId: string;
      childExecutionId: string;
      submissionId: string;
      sourceTurnId: string;
      title: string | null;
      content: string;
      contentType: string;
      interrupted: boolean;
    };

export interface RuntimeDeliveryCreateCommand {
  inboxItemId: string;
  targetConversationId: string;
  targetTurnId?: string | null;
  phase: RuntimeDeliveryPhase;
}

export interface RuntimeDeliveryResult {
  delivery: DomainRow;
  inputLink: DomainRow | null;
  parentHandlingState: ParentHandlingState;
}

export interface RuntimeDeliveryAdvanceResult extends RuntimeDeliveryResult {
  changed: boolean;
  commitSeq?: string;
}

export interface RuntimeDeliveryModelProjectionCommand {
  pendingTurnInputId: string;
  contentObjectId: string;
  content: string | Uint8Array;
  contentType: string;
}

export type AnswerDeliveryRecoveryDisposition =
  | {
      kind: 'existing';
      submissionId: string;
      inboxItemId: string;
      deliveryIds: string[];
    }
  | {
      kind: 'settled_by_answer';
      submissionId: string;
      inboxItemId: string;
    }
  | {
      kind: 'deferred_live_owner';
      submissionId: string;
      inboxItemId: string;
      sourceTurnId: string;
    }
  | {
      kind: 'delivery_required';
      submissionId: string;
      inboxItemId: string;
      command: RuntimeDeliveryCreateCommand;
      automaticSourceTurnId: string;
    };

type AnswerSubmissionOutcome = 'submitted' | 'interrupted' | 'failed';

interface AnswerSubmissionAuthority {
  bridge: DomainRow;
  childExecution: DomainRow;
  turnLink: DomainRow;
  turn: DomainRow;
  activeTurnLink: DomainRow | null;
  termination: DomainRow | null;
  currentSubmission: DomainRow | null;
}

const DELIVERY_PHASES = new Set<RuntimeDeliveryPhase>(['current_turn', 'next_turn', 'notify_only']);
const DELIVERY_STATES = new Set<RuntimeDeliveryState>(['pending', 'consumed', 'failed']);
const ACTIVE_TURN = 'active';
const TERMINATED_TURN = 'terminated';
const PROCESS_COMPLETION_MODEL_SOURCE_CONTENT_TYPE =
  'application/vnd.limcode.process-completion+json';

/** AnswerSubmission + AnswerBridge flip + RuntimeInboxItem atomic writer. */
export class AnswerControlPlane {
  private readonly now: () => string;
  private readonly automaticDeliveryRouter: AutomaticRuntimeDeliveryRouter;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly children: ChildExecutionControlPlane,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.automaticDeliveryRouter = new AutomaticRuntimeDeliveryRouter(database, contentStore);
  }

  public async submit(commandInput: AnswerSubmitCommand): Promise<AnswerSubmitResult> {
    const command = normalizeAnswerCommand(commandInput);
    const ids = answerIds(command.answerBridgeId, command.submissionId);
    const replay = await this.findReplay(command, ids);
    if (replay) return replay;
    const bridge = await this.requireExisting('AnswerBridge', command.answerBridgeId);
    const authority = await this.readSubmissionAuthority(command, bridge);
    const childExecutionId = requirePhaseFId(bridge.child_execution_id, 'AnswerBridge.child_execution_id');
    const payloadContent = await this.contentStore.prepare(
      this.database,
      command.content,
      command.contentType
    );
    const now = this.timestamp();
    const foreground = await this.children.prepareForegroundSettlement({
      childExecutionId,
      status: 'succeeded',
      detail: {
        answerBridgeId: command.answerBridgeId,
        answerSubmissionId: command.submissionId,
        answerContentObjectId: payloadContent.metadata.id,
        interrupted: false
      },
      sourceIdentity: `answer:${command.answerBridgeId}:${command.submissionId}`
    });
    const eligibleForeground = foreground && Date.parse(now) <= Date.parse(foreground.waitDeadlineAt)
      ? foreground
      : null;

    try {
      const commit = await this.database.transaction([
        ...answerAuthoritySteps(command, authority),
        ...answerFactSteps(command, ids, bridge, payloadContent, now, 'submitted'),
        ...(eligibleForeground ? eligibleForeground.steps : [])
      ]);
      if (eligibleForeground) {
        await this.children.finalizeWaitSettlement(eligibleForeground.toolCallId);
        await this.markInboxSettled(ids.inboxItemId);
      }
      return answerResult(command, ids, eligibleForeground !== null, false, false, commit.commitSeq);
    } catch (error) {
      if (
        eligibleForeground
        && isExpectedForegroundRace(error)
        && await this.foregroundRaceHasDurableWinner(eligibleForeground)
      ) {
        // The deadline/another answer durably won the ToolCall. Only this exact persisted winner
        // permits retrying the answer-only transaction; unrelated assertion failures propagate.
        const commit = await this.commitAnswerOnlyAfterForegroundRace(
          command,
          ids,
          bridge,
          authority,
          payloadContent,
          now
        );
        return answerResult(
          command,
          ids,
          false,
          commit.deduplicated,
          commit.historicalReplay,
          commit.commitSeq
        );
      }
      if (!isExpectedAnswerIdentityConflict(error)) throw error;
      const raced = await this.findReplay(command, ids, payloadContent);
      if (!raced) throw error;
      return raced;
    }
  }

  /**
   * Materializes one deterministic weak-signal answer when cancellation terminated a child Turn
   * before submit_agent_answer ran. Already submitted answers always win; concurrent recovery
   * contenders share the same submission identity and the bridge's current-submission CAS.
   */
  public async ensureInterruptedPartial(input: {
    childExecutionId: string;
    turnId: string;
    reason: string;
  }): Promise<AnswerSubmitResult | null> {
    const childExecutionId = requirePhaseFId(input.childExecutionId, 'childExecutionId');
    const turnId = requirePhaseFId(input.turnId, 'turnId');
    const reason = requirePhaseFText(input.reason, 'reason');
    const snapshot = await this.children.readExecutionSnapshot(childExecutionId);
    if (snapshot.currentSubmission) return null;
    const childStatus = requireChildExecutionStatus(snapshot.childExecution.status);
    if (childStatus !== 'interrupting' && childStatus !== 'interrupted') return null;
    if (snapshot.activeTurnLink !== null) return null;
    const allTurnLinks = await listAllDomainRows(this.database, 'ChildExecutionTurnLink', {
      child_execution_id: childExecutionId
    });
    const sourceTurnLink = allTurnLinks.find((link) => link.turn_id === turnId);
    if (!sourceTurnLink) {
      throw new Error(`Turn ${turnId} is not a member of ChildExecution ${childExecutionId}.`);
    }
    const latestTurnLink = [...allTurnLinks].sort((left, right) => {
      const a = BigInt(String(left.turn_seq));
      const b = BigInt(String(right.turn_seq));
      return a < b ? 1 : a > b ? -1 : 0;
    })[0];
    if (!latestTurnLink || latestTurnLink.id !== sourceTurnLink.id) return null;
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== TERMINATED_TURN) return null;
    const terminations = await this.listRows('TurnTermination', { turn_id: turnId }, 2);
    if (terminations.length !== 1 || !['interrupted', 'cancelled'].includes(String(terminations[0].terminal_status))) {
      return null;
    }
    const bridge = snapshot.answerBridge;
    if (!['open', 'interrupted'].includes(String(bridge.status))) return null;
    const content = await this.interruptedPartialContent(turnId, reason);
    const submissionId = stablePhaseFId('answer_submission', 'interrupted-partial', childExecutionId, turnId);
    const command = normalizeAnswerCommand({
      answerBridgeId: requirePhaseFId(bridge.id, 'AnswerBridge.id'),
      submissionId,
      sourceTurnId: turnId,
      title: '子 Agent 已中断（部分结果）',
      content,
      contentType: 'text/markdown'
    });
    const ids = answerIds(command.answerBridgeId, submissionId);
    const replay = await this.findReplay(command, ids, undefined, 'interrupted');
    if (replay) return replay.historicalReplay ? null : replay;
    const payloadContent = await this.contentStore.prepare(this.database, content, command.contentType);
    const now = this.timestamp();
    const foreground = await this.children.prepareForegroundSettlement({
      childExecutionId,
      status: 'partial',
      detail: {
        answerBridgeId: command.answerBridgeId,
        answerSubmissionId: submissionId,
        answerContentObjectId: payloadContent.metadata.id,
        interrupted: true
      },
      sourceIdentity: `interrupted-answer:${command.answerBridgeId}:${submissionId}`
    });
    const eligibleForeground = foreground && Date.parse(now) <= Date.parse(foreground.waitDeadlineAt)
      ? foreground
      : null;
    const authority: AnswerSubmissionAuthority = {
      bridge,
      childExecution: snapshot.childExecution,
      turnLink: sourceTurnLink,
      turn,
      activeTurnLink: null,
      termination: terminations[0],
      currentSubmission: null
    };
    const authoritySteps = interruptedAnswerAuthoritySteps(
      command,
      authority,
      allTurnLinks.map((link) => requirePhaseFId(link.id, 'ChildExecutionTurnLink.id'))
    );
    try {
      const commit = await this.database.transaction([
        ...authoritySteps,
        ...answerFactSteps(command, ids, bridge, payloadContent, now, 'interrupted'),
        ...(eligibleForeground ? eligibleForeground.steps : [])
      ]);
      if (eligibleForeground) {
        await this.children.finalizeWaitSettlement(eligibleForeground.toolCallId);
        await this.markInboxSettled(ids.inboxItemId);
      }
      return answerResult(command, ids, eligibleForeground !== null, false, false, commit.commitSeq);
    } catch (error) {
      if (
        eligibleForeground
        && isExpectedForegroundRace(error)
        && await this.foregroundRaceHasDurableWinner(eligibleForeground)
      ) {
        try {
          const commit = await this.database.transaction([
            ...authoritySteps,
            ...answerFactSteps(command, ids, bridge, payloadContent, now, 'interrupted')
          ]);
          return answerResult(command, ids, false, false, false, commit.commitSeq);
        } catch (retryError) {
          error = retryError;
        }
      }
      if (isTransactionAssertionFailure(error)) return null;
      if (!isExpectedAnswerIdentityConflict(error)) throw error;
      const raced = await this.findReplay(command, ids, payloadContent, 'interrupted');
      if (raced) return raced.historicalReplay ? null : raced;
      const latest = await this.children.readExecutionSnapshot(childExecutionId);
      if (latest.currentSubmission) return null;
      throw error;
    }
  }

  /** Publishes one deterministic failed answer for a terminal child drive with no submitted answer. */
  public async ensureFailed(input: {
    childExecutionId: string;
    turnId: string;
    reason: string;
  }): Promise<AnswerSubmitResult | null> {
    const childExecutionId = requirePhaseFId(input.childExecutionId, 'childExecutionId');
    const turnId = requirePhaseFId(input.turnId, 'turnId');
    const reason = requirePhaseFText(input.reason, 'reason');
    const snapshot = await this.children.readExecutionSnapshot(childExecutionId);
    if (snapshot.currentSubmission) return null;
    const allTurnLinks = await listAllDomainRows(this.database, 'ChildExecutionTurnLink', {
      child_execution_id: childExecutionId
    });
    const sourceTurnLink = allTurnLinks.find((link) => link.turn_id === turnId);
    if (!sourceTurnLink) {
      throw new Error(`Turn ${turnId} is not a member of ChildExecution ${childExecutionId}.`);
    }
    const latestTurnLink = [...allTurnLinks].sort((left, right) => {
      const a = BigInt(String(left.turn_seq));
      const b = BigInt(String(right.turn_seq));
      return a < b ? 1 : a > b ? -1 : 0;
    })[0];
    if (!latestTurnLink || latestTurnLink.id !== sourceTurnLink.id) return null;
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== TERMINATED_TURN) return null;
    const terminations = await this.listRows('TurnTermination', { turn_id: turnId }, 2);
    if (terminations.length !== 1 || terminations[0].terminal_status !== 'failed') return null;
    const bridge = snapshot.answerBridge;
    if (!['open', 'submitted'].includes(String(bridge.status))) return null;
    const submissionId = stablePhaseFId('answer_submission', 'child-drive-failed', childExecutionId, turnId);
    const content = `> 子 Agent 执行失败。\n\n失败原因：${reason}`;
    const command = normalizeAnswerCommand({
      answerBridgeId: requirePhaseFId(bridge.id, 'AnswerBridge.id'),
      submissionId,
      sourceTurnId: turnId,
      title: '子 Agent 执行失败',
      content,
      contentType: 'text/markdown'
    });
    const ids = answerIds(command.answerBridgeId, submissionId);
    const replay = await this.findReplay(command, ids, undefined, 'failed');
    if (replay) return replay.historicalReplay ? null : replay;
    const payloadContent = await this.contentStore.prepare(this.database, content, command.contentType);
    const authority: AnswerSubmissionAuthority = {
      bridge,
      childExecution: snapshot.childExecution,
      turnLink: sourceTurnLink,
      turn,
      activeTurnLink: snapshot.activeTurnLink,
      termination: terminations[0],
      currentSubmission: null
    };
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction([
        ...failedAnswerAuthoritySteps(
          command,
          authority,
          allTurnLinks.map((link) => requirePhaseFId(link.id, 'ChildExecutionTurnLink.id'))
        ),
        ...answerFactSteps(command, ids, bridge, payloadContent, now, 'failed')
      ]);
      return answerResult(command, ids, false, false, false, commit.commitSeq);
    } catch (error) {
      if (isTransactionAssertionFailure(error)) return null;
      if (!isExpectedAnswerIdentityConflict(error)) throw error;
      const raced = await this.findReplay(command, ids, payloadContent, 'failed');
      if (raced) return raced.historicalReplay ? null : raced;
      const latest = await this.children.readExecutionSnapshot(childExecutionId);
      if (latest.currentSubmission) return null;
      throw error;
    }
  }

  /** Reconciles one failed child Turn into direct wait failure or a durable background delivery source. */
  public async reconcileFailedTurn(input: {
    childExecutionId: string;
    turnId: string;
    reason: string;
  }): Promise<{
    answerBridgeId: string;
    submissionId: string;
    inboxItemId: string;
    disposition: AnswerDeliveryRecoveryDisposition;
  } | null> {
    const childExecutionId = requirePhaseFId(input.childExecutionId, 'childExecutionId');
    const turnId = requirePhaseFId(input.turnId, 'turnId');
    const reason = requirePhaseFText(input.reason, 'reason');
    await this.children.settleForegroundFailure(childExecutionId, turnId, reason);
    await this.ensureFailed({ childExecutionId, turnId, reason });
    const snapshot = await this.children.readExecutionSnapshot(childExecutionId);
    const answerBridgeId = requirePhaseFId(snapshot.answerBridge.id, 'AnswerBridge.id');
    const current = await this.readCurrent(answerBridgeId);
    if (current.status !== 'failed' || current.sourceTurnId !== turnId) return null;
    const waits = await this.reconcileCommittedWaits(current.submissionId);
    return {
      answerBridgeId,
      submissionId: current.submissionId,
      inboxItemId: waits.inboxItemId,
      disposition: await this.classifyDeliveryRecovery(current.submissionId)
    };
  }

  private async markInboxSettled(inboxItemId: string): Promise<void> {
    const inbox = await this.requireExisting('RuntimeInboxItem', inboxItemId);
    if (inbox.state === 'settled') return;
    if (inbox.state !== 'available') {
      throw new Error(`RuntimeInboxItem ${inboxItemId} cannot settle from ${String(inbox.state)}.`);
    }
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(inboxItemId, { state: 'available' }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').update(inboxItemId, {
          state: 'settled',
          updated_at: now
        })
      ]);
    } catch (error) {
      if (!isTransactionAssertionFailure(error)) throw error;
      const raced = await this.requireExisting('RuntimeInboxItem', inboxItemId);
      if (raced.state !== 'settled') throw error;
    }
  }

  /** Read-only latest-answer selector. It never consumes RuntimeInbox or changes delivery state. */
  public async readCurrent(answerBridgeIdInput: string): Promise<AnswerReadResult> {
    const answerBridgeId = requirePhaseFId(answerBridgeIdInput, 'answerBridgeId');
    const bridge = await this.maybeGet('AnswerBridge', answerBridgeId);
    if (!bridge) return { status: 'not_found' };
    const childExecutionId = requirePhaseFId(bridge.child_execution_id, 'AnswerBridge.child_execution_id');
    const snapshot = await this.children.readExecutionSnapshot(childExecutionId);
    if (!snapshot.currentSubmission) {
      const running = snapshot.activeTurn?.status === ACTIVE_TURN
        || ['starting', 'active'].includes(String(snapshot.childExecution.status));
      return running
        ? { status: 'running', answerBridgeId, childExecutionId }
        : { status: 'interrupted', answerBridgeId, childExecutionId };
    }
    const submissionId = requirePhaseFId(snapshot.currentSubmission.id, 'AnswerSubmission.id');
    const payloads = await this.listRows('AnswerPayload', { submission_id: submissionId }, 2);
    if (payloads.length !== 1) throw new Error('Current AnswerSubmission must have exactly one AnswerPayload.');
    const payload = payloads[0];
    const contentRow = await this.requireExisting(
      'ContentObject',
      requirePhaseFId(payload.content_object_id, 'AnswerPayload.content_object_id')
    ) as ContentObjectMetadata;
    const content = (await this.contentStore.read(contentRow)).toString('utf8');
    const sourceTurnId = requirePhaseFId(snapshot.currentSubmission.turn_id, 'AnswerSubmission.turn_id');
    const title = payload.title === null ? null : requirePhaseFText(payload.title, 'AnswerPayload.title');
    const outcome = answerSubmissionOutcome(snapshot.currentSubmission, childExecutionId);
    if (outcome === 'failed') {
      return {
        status: 'failed',
        answerBridgeId,
        childExecutionId,
        submissionId,
        sourceTurnId,
        title,
        content,
        contentType: contentRow.content_type
      };
    }
    return {
      status: 'submitted',
      answerBridgeId,
      childExecutionId,
      submissionId,
      sourceTurnId,
      title,
      content,
      contentType: contentRow.content_type,
      interrupted: outcome === 'interrupted'
    };
  }

  /** Recovery-only invariant repair, fenced against a live source-Turn owner. */
  public async ensureInboxForSubmission(answerSubmissionIdInput: string): Promise<{
    inboxItemId: string;
    created: boolean;
    deferredLiveOwner?: string;
    commitSeq?: string;
  }> {
    const submissionId = requirePhaseFId(answerSubmissionIdInput, 'answerSubmissionId');
    const submission = await this.requireExisting('AnswerSubmission', submissionId);
    const bridgeId = requirePhaseFId(submission.answer_bridge_id, 'AnswerSubmission.answer_bridge_id');
    const ids = answerIds(bridgeId, submissionId);
    const sourceTurnId = requirePhaseFId(submission.turn_id, 'AnswerSubmission.turn_id');
    const sourceAuthority = await this.readRecoverySourceAuthority(sourceTurnId);
    if (sourceAuthority.liveOwner) {
      return {
        inboxItemId: ids.inboxItemId,
        created: false,
        deferredLiveOwner: sourceTurnId
      };
    }
    const payloads = await this.listRows('AnswerPayload', { submission_id: submissionId }, 2);
    if (payloads.length !== 1) throw new Error('AnswerSubmission must have exactly one AnswerPayload before inbox repair.');
    const payloadContentObjectId = requirePhaseFId(
      payloads[0].content_object_id,
      'AnswerPayload.content_object_id'
    );
    const rows = await this.listRows('RuntimeInboxItem', {
      dedupe_key: answerDedupeKey(bridgeId, submissionId)
    }, 2);
    if (rows.length === 1) {
      if (rows[0].source_kind !== 'answer_submission' || rows[0].source_id !== submissionId) {
        throw new Error('Answer RuntimeInboxItem dedupe key points to a different source identity.');
      }
      await this.ensureInboxPayloadLink(
        requirePhaseFId(rows[0].id, 'RuntimeInboxItem.id'),
        ids.inboxPayloadLinkId,
        payloadContentObjectId,
        sourceAuthority.steps
      );
      return { inboxItemId: rows[0].id as string, created: false };
    }
    if (rows.length > 1) throw new Error('Answer RuntimeInboxItem dedupe identity is not unique.');
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction([
        ...sourceAuthority.steps,
        DOMAIN_REPOSITORIES.domain('AnswerSubmission').assert(submissionId, {
          answer_bridge_id: bridgeId,
          submission_seq: submission.submission_seq
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({
          id: ids.inboxItemId,
          dedupe_key: answerDedupeKey(bridgeId, submissionId),
          source_kind: 'answer_submission',
          source_id: submissionId,
          state: 'available',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxPayloadLink').insert({
          id: ids.inboxPayloadLinkId,
          inbox_item_id: ids.inboxItemId,
          content_object_id: payloadContentObjectId,
          created_at: now
        })
      ]);
      return { inboxItemId: ids.inboxItemId, created: true, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!sqliteUniqueFailureIncludes(error, [
        'runtime_inbox_item.dedupe_key',
        'runtime_inbox_item.id',
        'runtime_inbox_payload_link.id',
        'runtime_inbox_payload_link.inbox_item_id'
      ])) throw error;
      const raced = await this.listRows('RuntimeInboxItem', {
        dedupe_key: answerDedupeKey(bridgeId, submissionId)
      }, 2);
      if (raced.length !== 1) throw error;
      await this.ensureInboxPayloadLink(
        requirePhaseFId(raced[0].id, 'RuntimeInboxItem.id'),
        ids.inboxPayloadLinkId,
        payloadContentObjectId,
        sourceAuthority.steps
      );
      return { inboxItemId: raced[0].id as string, created: false };
    }
  }

  /**
   * Replays the post-submit parent-wait edge from immutable AnswerSubmission facts.
   *
   * AnswerSubmission/RuntimeInboxItem commit before coordinator orchestration. If that caller is
   * interrupted after the commit (or its submit_agent_answer ToolCall is subsequently failed), the
   * answer must still win every eligible parent wait bound to its exact child Turn generation.
   * This method is deliberately idempotent and is shared by live coordinator and startup recovery.
   */
  public async reconcileCommittedWaits(
    answerSubmissionIdInput: string
  ): Promise<AnswerWaitRecoveryResult> {
    const submissionId = requirePhaseFId(answerSubmissionIdInput, 'answerSubmissionId');
    const submission = await this.requireExisting('AnswerSubmission', submissionId);
    const answerBridgeId = requirePhaseFId(
      submission.answer_bridge_id,
      'AnswerSubmission.answer_bridge_id'
    );
    const sourceTurnId = requirePhaseFId(submission.turn_id, 'AnswerSubmission.turn_id');
    const observedAt = requireIsoTimestamp(submission.created_at, 'AnswerSubmission.created_at');
    const bridge = await this.requireExisting('AnswerBridge', answerBridgeId);
    const childExecutionId = requirePhaseFId(
      bridge.child_execution_id,
      'AnswerBridge.child_execution_id'
    );
    const parentLinks = await this.listRows('ChildExecutionParentLink', {
      child_execution_id: childExecutionId
    }, 2);
    if (parentLinks.length !== 1) {
      throw new Error('Answer wait recovery requires exactly one ChildExecutionParentLink.');
    }
    const payloads = await this.listRows('AnswerPayload', { submission_id: submissionId }, 2);
    if (payloads.length !== 1) {
      throw new Error('Answer wait recovery requires exactly one AnswerPayload.');
    }
    const payload = payloads[0];
    const contentRow = await this.requireExisting(
      'ContentObject',
      requirePhaseFId(payload.content_object_id, 'AnswerPayload.content_object_id')
    ) as ContentObjectMetadata;
    const content = (await this.contentStore.read(contentRow)).toString('utf8');
    const title = payload.title === null
      ? null
      : requirePhaseFText(payload.title, 'AnswerPayload.title');
    const outcome = answerSubmissionOutcome(submission, childExecutionId);
    const detail = outcome === 'failed'
      ? {
          ok: false,
          status: 'failed',
          failed: true,
          reason: content,
          answerBridgeId,
          submissionId,
          title,
          content
        }
      : outcome === 'interrupted'
        ? {
            ok: false,
            status: 'interrupted',
            partial: true,
            interrupted: true,
            answerBridgeId,
            submissionId,
            title,
            content
          }
        : {
            ok: true,
            answerBridgeId,
            submissionId,
            title,
            content
          };
    const continuationSettlements: ChildWaitSettlement[] = [];
    const waitingOperations = (await this.children.listContinuationWaitOperations({
      answerBridgeId,
      sourceTurnId,
      status: 'waiting_answer'
    })).sort((left, right) => compareCounter(left.operation_seq, right.operation_seq));
    for (const operation of waitingOperations) {
      const toolCallId = requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id');
      // Settlement identity is per ToolCall. One durable winner for this submission must not make
      // recovery skip another wait from the same child Turn generation.
      if (await this.wasSubmissionUsedToSettleToolCall(submissionId, toolCallId)) continue;
      continuationSettlements.push(...await this.children.settleContinuationWaits({
        answerBridgeId,
        sourceTurnId,
        toolCallId,
        detail,
        status: outcome === 'failed' ? 'failed' : outcome === 'interrupted' ? 'partial' : 'succeeded',
        sourceIdentity: `${outcome === 'failed' ? 'failed-answer' : outcome === 'interrupted' ? 'interrupted-answer' : 'answer'}:${submissionId}`,
        observedAt
      }));
    }

    // A crash may leave a terminal Operation + ToolResultArtifact behind an earlier ToolCall in
    // the ordered batch. Retrying finalization is required even when there is no waiting Operation.
    const waitToolCallIds = new Set<string>([
      requirePhaseFId(
        parentLinks[0].source_tool_call_id,
        'ChildExecutionParentLink.source_tool_call_id'
      )
    ]);
    const continuationOperations = await this.children.listContinuationWaitOperations({
      answerBridgeId,
      sourceTurnId
    });
    for (const operation of continuationOperations) {
      if (operation.tool_call_id !== null) {
        waitToolCallIds.add(requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id'));
      }
    }
    for (const toolCallId of waitToolCallIds) {
      await this.children.finalizeWaitSettlement(toolCallId);
    }

    const inboxRows = await this.listRows('RuntimeInboxItem', {
      dedupe_key: answerDedupeKey(answerBridgeId, submissionId)
    }, 2);
    if (inboxRows.length !== 1) {
      throw new Error('Answer wait recovery requires exactly one RuntimeInboxItem.');
    }
    const inboxItemId = requirePhaseFId(inboxRows[0].id, 'RuntimeInboxItem.id');
    const settledByAnswer = await this.wasSubmissionUsedToSettleAnyWait(
      submissionId,
      answerBridgeId,
      parentLinks[0],
      sourceTurnId
    );
    if (settledByAnswer) await this.markInboxSettled(inboxItemId);
    return {
      answerBridgeId,
      submissionId,
      inboxItemId,
      sourceTurnId,
      newlySettledToolCallIds: continuationSettlements.map((settlement) => settlement.toolCallId),
      settledByAnswer
    };
  }

  /**
   * Recovery-only classifier for the AnswerSubmission -> RuntimeDelivery crash boundary.
   *
   * The submit transaction deliberately commits the immutable answer before product orchestration
   * chooses a parent destination.  A Host can therefore die with a complete Submission/Inbox but
   * no Delivery.  This method reconstructs that missing decision exclusively from stable lineage
   * and durable wait artifact/outcome content. A live source Turn is deferred so a second Extension
   * Host cannot race the coordinator between answer commit and foreground settlement/delivery
   * creation.
   */
  public async classifyDeliveryRecovery(
    answerSubmissionIdInput: string
  ): Promise<AnswerDeliveryRecoveryDisposition> {
    const submissionId = requirePhaseFId(answerSubmissionIdInput, 'answerSubmissionId');
    const submission = await this.requireExisting('AnswerSubmission', submissionId);
    const answerBridgeId = requirePhaseFId(
      submission.answer_bridge_id,
      'AnswerSubmission.answer_bridge_id'
    );
    const inboxRows = await this.listRows('RuntimeInboxItem', {
      dedupe_key: answerDedupeKey(answerBridgeId, submissionId)
    }, 2);
    if (inboxRows.length !== 1) {
      throw new Error('AnswerSubmission delivery recovery requires exactly one RuntimeInboxItem.');
    }
    const inboxItemId = requirePhaseFId(inboxRows[0].id, 'RuntimeInboxItem.id');
    if (
      inboxRows[0].source_kind !== 'answer_submission'
      || inboxRows[0].source_id !== submissionId
    ) throw new Error('AnswerSubmission RuntimeInboxItem has a conflicting source identity.');

    const existingDeliveries = await listAllDomainRows(this.database, 'RuntimeDelivery', {
      inbox_item_id: inboxItemId
    });
    if (existingDeliveries.length > 0) {
      return {
        kind: 'existing',
        submissionId,
        inboxItemId,
        deliveryIds: existingDeliveries.map((row) =>
          requirePhaseFId(row.id, 'RuntimeDelivery.id')
        )
      };
    }

    const bridge = await this.requireExisting('AnswerBridge', answerBridgeId);
    const childExecutionId = requirePhaseFId(
      bridge.child_execution_id,
      'AnswerBridge.child_execution_id'
    );
    const parentLinks = await this.listRows('ChildExecutionParentLink', {
      child_execution_id: childExecutionId
    }, 2);
    if (parentLinks.length !== 1) {
      throw new Error('AnswerSubmission delivery recovery requires exactly one ChildExecutionParentLink.');
    }
    const sourceTurnId = requirePhaseFId(submission.turn_id, 'AnswerSubmission.turn_id');
    if (await this.wasSubmissionUsedToSettleAnyWait(
      submissionId,
      answerBridgeId,
      parentLinks[0],
      sourceTurnId
    )) {
      return { kind: 'settled_by_answer', submissionId, inboxItemId };
    }

    if (await this.isTurnOwnedByLiveHost(sourceTurnId)) {
      return { kind: 'deferred_live_owner', submissionId, inboxItemId, sourceTurnId };
    }

    const parentTurnId = requirePhaseFId(
      parentLinks[0].parent_turn_id,
      'ChildExecutionParentLink.parent_turn_id'
    );
    const parentTurn = await this.requireExisting('Turn', parentTurnId);
    const targetConversationId = requirePhaseFId(
      parentTurn.conversation_id,
      'Parent Turn.conversation_id'
    );
    const decision = await this.automaticDeliveryRouter.resolve({
      inboxItemId,
      targetConversationId,
      sourceTurnId: parentTurnId
    });
    return {
      kind: 'delivery_required',
      submissionId,
      inboxItemId,
      automaticSourceTurnId: parentTurnId,
      command: {
        inboxItemId,
        targetConversationId,
        targetTurnId: decision.targetTurnId,
        phase: decision.phase
      }
    };
  }

  /** Read-only ownership preflight for recovery orchestrators before any invariant repair. */
  public async liveSourceTurnForRecovery(
    answerSubmissionIdInput: string
  ): Promise<string | null> {
    const submissionId = requirePhaseFId(answerSubmissionIdInput, 'answerSubmissionId');
    const submission = await this.requireExisting('AnswerSubmission', submissionId);
    const sourceTurnId = requirePhaseFId(submission.turn_id, 'AnswerSubmission.turn_id');
    return await this.isTurnOwnedByLiveHost(sourceTurnId) ? sourceTurnId : null;
  }

  private async interruptedPartialContent(turnId: string, reason: string): Promise<string> {
    const links = (await listAllDomainRows(this.database, 'MessageTurnLink', {
      turn_id: turnId,
      role: 'model'
    })).sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))
      || String(left.id).localeCompare(String(right.id)));
    const visible: string[] = [];
    for (const link of links) {
      const messageId = requirePhaseFId(link.message_id, 'MessageTurnLink.message_id');
      const current = await this.listRows('MessageCurrentRevisionLink', { message_id: messageId }, 2);
      if (current.length !== 1) continue;
      const revision = await this.requireExisting(
        'MessageRevision',
        requirePhaseFId(current[0].revision_id, 'MessageCurrentRevisionLink.revision_id')
      );
      const metadata = await this.requireExisting(
        'ContentObject',
        requirePhaseFId(revision.content_object_id, 'MessageRevision.content_object_id')
      ) as ContentObjectMetadata;
      const raw = (await this.contentStore.read(metadata)).toString('utf8');
      const extracted = extractVisibleAssistantText(raw, metadata.content_type);
      if (extracted) visible.push(extracted);
    }
    const joined = visible.join('\n\n').trim();
    return joined
      ? `> 子 Agent 在完成前被中断；以下是中断前已经持久化的可见结果。\n\n${joined}\n\n---\n中断原因：${reason}`
      : `> 子 Agent 在提交完整回答前被中断，尚未形成可持久化的可见部分结果。\n\n中断原因：${reason}`;
  }

  private async ensureInboxPayloadLink(
    inboxItemId: string,
    linkId: string,
    contentObjectId: string,
    authoritySteps: RepositoryTransactionStep[] = []
  ): Promise<void> {
    const links = await this.listRows('RuntimeInboxPayloadLink', { inbox_item_id: inboxItemId }, 2);
    if (links.length === 1) {
      if (links[0].id !== linkId || links[0].content_object_id !== contentObjectId) {
        throw new Error('Answer RuntimeInboxPayloadLink points to a different payload identity.');
      }
      return;
    }
    if (links.length > 1) throw new Error('RuntimeInboxItem has multiple payload links.');
    const now = this.timestamp();
    try {
      await this.database.transaction([
        ...authoritySteps,
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(inboxItemId, {
          source_kind: 'answer_submission'
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxPayloadLink').insert({
          id: linkId,
          inbox_item_id: inboxItemId,
          content_object_id: contentObjectId,
          created_at: now
        })
      ]);
    } catch (error) {
      if (!sqliteUniqueFailureIncludes(error, [
        'runtime_inbox_payload_link.id',
        'runtime_inbox_payload_link.inbox_item_id'
      ])) throw error;
      const raced = await this.listRows('RuntimeInboxPayloadLink', { inbox_item_id: inboxItemId }, 2);
      if (raced.length !== 1 || raced[0].id !== linkId || raced[0].content_object_id !== contentObjectId) {
        throw error;
      }
    }
  }

  private async readRecoverySourceAuthority(sourceTurnId: string): Promise<{
    liveOwner: boolean;
    steps: RepositoryTransactionStep[];
  }> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(sourceTurnId),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({
        where: { turn_id: sourceTurnId },
        limit: 2
      })
    ]);
    const turn = requireRow(snapshot.snapshot[0], `Turn ${sourceTurnId}`);
    const leases = requireRows(snapshot.snapshot[1], 'Answer recovery source ExecutionLease');
    if (leases.length > 1) throw new Error('Turn has multiple ExecutionLeases.');
    const lease = leases[0] ?? null;
    const liveOwner = turn.status === ACTIVE_TURN
      && lease !== null
      && await this.database.isHostAlive(
        requirePhaseFId(lease.host_boot_id, 'ExecutionLease.host_boot_id')
      );
    return {
      liveOwner,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(sourceTurnId, { status: turn.status }),
        ...(lease
          ? [DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(
              requirePhaseFId(lease.id, 'ExecutionLease.id'),
              {
                turn_id: sourceTurnId,
                owner_id: lease.owner_id,
                host_boot_id: lease.host_boot_id,
                generation: lease.generation
              }
            )]
          : [DOMAIN_REPOSITORIES.domain('ExecutionLease').assertNone({ turn_id: sourceTurnId })])
      ]
    };
  }

  private async wasSubmissionUsedToSettleAnyWait(
    submissionId: string,
    answerBridgeId: string,
    parentLink: DomainRow,
    sourceTurnId: string
  ): Promise<boolean> {
    const toolCallIds = new Set<string>([
      requirePhaseFId(parentLink.source_tool_call_id, 'ChildExecutionParentLink.source_tool_call_id')
    ]);
    const continuationOperations = await this.children.listContinuationWaitOperations({
      answerBridgeId,
      sourceTurnId
    });
    for (const operation of continuationOperations) {
      if (operation.tool_call_id !== null) {
        toolCallIds.add(requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id'));
      }
    }
    for (const toolCallId of toolCallIds) {
      if (await this.wasSubmissionUsedToSettleToolCall(submissionId, toolCallId)) return true;
    }
    return false;
  }

  private async wasSubmissionUsedToSettleToolCall(
    submissionId: string,
    toolCallId: string
  ): Promise<boolean> {
    const artifacts = await this.listRows('ToolResultArtifact', {
      tool_call_id: toolCallId,
      role: 'no_effect_result'
    }, 2);
    if (artifacts.length > 1) throw new Error('ToolCall has multiple no-effect ToolResultArtifacts.');
    if (artifacts.length === 1 && await this.contentIdentifiesSubmission(
      requirePhaseFId(artifacts[0].content_object_id, 'ToolResultArtifact.content_object_id'),
      submissionId,
      `ToolResultArtifact ${String(artifacts[0].id)}`
    )) return true;
    const outcomes = await this.listRows('ToolOutcome', { tool_call_id: toolCallId }, 2);
    if (outcomes.length > 1) throw new Error('ToolCall has multiple terminal ToolOutcomes.');
    if (outcomes.length === 0) return false;
    return this.contentIdentifiesSubmission(
      requirePhaseFId(outcomes[0].content_object_id, 'ToolOutcome.content_object_id'),
      submissionId,
      `ToolOutcome ${String(outcomes[0].id)}`
    );
  }

  private async contentIdentifiesSubmission(
    contentObjectId: string,
    submissionId: string,
    label: string
  ): Promise<boolean> {
    const content = await this.requireExisting('ContentObject', contentObjectId) as ContentObjectMetadata;
    let decoded: unknown;
    try {
      decoded = JSON.parse((await this.contentStore.read(content)).toString('utf8'));
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : '';
      throw new Error(`${label} has invalid terminal JSON${detail}.`);
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return false;
    const detail = (decoded as { detail?: unknown }).detail;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false;
    const identity = detail as { submissionId?: unknown; answerSubmissionId?: unknown };
    return identity.submissionId === submissionId
      || identity.answerSubmissionId === submissionId;
  }

  private async isTurnOwnedByLiveHost(turnId: string): Promise<boolean> {
    const turn = await this.maybeGet('Turn', turnId);
    if (!turn || turn.status !== ACTIVE_TURN) return false;
    const leases = await this.listRows('ExecutionLease', { turn_id: turnId }, 2);
    if (leases.length > 1) throw new Error('Turn has multiple ExecutionLeases.');
    if (leases.length === 0) return false;
    return this.database.isHostAlive(
      requirePhaseFId(leases[0].host_boot_id, 'ExecutionLease.host_boot_id')
    );
  }

  private async foregroundRaceHasDurableWinner(
    settlement: PreparedForegroundSettlement
  ): Promise<boolean> {
    return (await this.children.finalizeWaitSettlement(settlement.toolCallId)) !== null;
  }

  private async readSubmissionAuthority(
    command: ReturnType<typeof normalizeAnswerCommand>,
    bridge: DomainRow
  ): Promise<AnswerSubmissionAuthority> {
    const childExecutionId = requirePhaseFId(bridge.child_execution_id, 'AnswerBridge.child_execution_id');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').get(childExecutionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({
        where: { turn_id: command.sourceTurnId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('Turn').get(command.sourceTurnId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').list({
        where: { child_execution_id: childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('TurnTermination').list({
        where: { turn_id: command.sourceTurnId },
        limit: 2
      }),
      ...(bridge.current_submission_id === null
        ? []
        : [DOMAIN_REPOSITORIES.domain('AnswerSubmission').get(
            requirePhaseFId(bridge.current_submission_id, 'AnswerBridge.current_submission_id')
          )])
    ]);
    const childExecution = requireRow(snapshot.snapshot[0], `ChildExecution ${childExecutionId}`);
    const turnLinks = requireRows(snapshot.snapshot[1], 'Answer ChildExecutionTurnLink authority');
    const turn = requireRow(snapshot.snapshot[2], `Turn ${command.sourceTurnId}`);
    const activeLinks = requireRows(snapshot.snapshot[3], 'Answer active Child Turn authority');
    const terminations = requireRows(snapshot.snapshot[4], 'Answer TurnTermination authority');
    const currentSubmission = bridge.current_submission_id === null
      ? null
      : requireRow(snapshot.snapshot[5], `AnswerSubmission ${String(bridge.current_submission_id)}`);
    if (turnLinks.length !== 1 || turnLinks[0].child_execution_id !== childExecutionId) {
      throw new Error(
        `Answer submission Turn ${command.sourceTurnId} is not a member of AnswerBridge ${command.answerBridgeId}.`
      );
    }
    if (activeLinks.length > 1 || terminations.length > 1) {
      throw new Error('Answer submission authority is not unique.');
    }
    const childStatus = requireChildExecutionStatus(childExecution.status);
    if (bridge.status === 'closed' || childStatus === 'closed' || childStatus === 'needs_human') {
      throw new Error('Answer submission is rejected because the ChildExecution is closed.');
    }

    const activeTurnLink = activeLinks[0] ?? null;
    const termination = terminations[0] ?? null;
    if (turn.status !== ACTIVE_TURN || termination) {
      throw new Error(`Answer submission rejected for stale or terminal Child Turn ${command.sourceTurnId}.`);
    }
    if (!activeTurnLink || activeTurnLink.turn_id !== command.sourceTurnId) {
      throw new Error(`Answer submission rejected because Child Turn ${command.sourceTurnId} is not the active generation.`);
    }
    if (childStatus !== 'active') {
      throw new Error(`Answer submission rejected from ChildExecution state ${childStatus}.`);
    }
    if (!['open', 'submitted'].includes(String(bridge.status))) {
      throw new Error(`AnswerBridge ${command.answerBridgeId} is not open for the active Child Turn.`);
    }
    if (currentSubmission && currentSubmission.turn_id !== command.sourceTurnId) {
      throw new Error('AnswerBridge still points at a different Child Turn generation.');
    }
    return {
      bridge,
      childExecution,
      turnLink: turnLinks[0],
      turn,
      activeTurnLink,
      termination,
      currentSubmission
    };
  }

  private async commitAnswerOnlyAfterForegroundRace(
    command: ReturnType<typeof normalizeAnswerCommand>,
    ids: ReturnType<typeof answerIds>,
    bridge: DomainRow,
    authority: AnswerSubmissionAuthority,
    payloadContent: PreparedContentObject,
    now: string
  ): Promise<{ deduplicated: boolean; historicalReplay: boolean; commitSeq?: string }> {
    const replay = await this.findReplay(command, ids, payloadContent);
    if (replay) return { deduplicated: true, historicalReplay: replay.historicalReplay };
    try {
      const commit = await this.database.transaction([
        ...answerAuthoritySteps(command, authority),
        ...answerFactSteps(command, ids, bridge, payloadContent, now, 'submitted')
      ]);
      return { deduplicated: false, historicalReplay: false, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!isExpectedAnswerIdentityConflict(error)) throw error;
      const raced = await this.findReplay(command, ids, payloadContent);
      if (!raced) throw error;
      return { deduplicated: true, historicalReplay: raced.historicalReplay };
    }
  }

  private async findReplay(
    command: ReturnType<typeof normalizeAnswerCommand>,
    ids: ReturnType<typeof answerIds>,
    prepared?: PreparedContentObject,
    outcome: AnswerSubmissionOutcome = 'submitted'
  ): Promise<AnswerSubmitResult | null> {
    const submission = await this.maybeGet('AnswerSubmission', command.submissionId);
    if (!submission) return null;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AnswerPayload').list({
        where: { submission_id: command.submissionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').list({
        where: { dedupe_key: answerDedupeKey(command.answerBridgeId, command.submissionId) },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeInboxPayloadLink').list({
        where: { inbox_item_id: ids.inboxItemId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').get(command.answerBridgeId)
    ]);
    const payloads = requireRows(snapshot.snapshot[0], 'AnswerPayload replay lookup');
    const inboxRows = requireRows(snapshot.snapshot[1], 'RuntimeInboxItem replay lookup');
    const payloadLinks = requireRows(snapshot.snapshot[2], 'RuntimeInboxPayloadLink replay lookup');
    const bridge = requireRow(snapshot.snapshot[3], `AnswerBridge ${command.answerBridgeId}`);
    if (payloads.length !== 1 || inboxRows.length !== 1 || payloadLinks.length !== 1) {
      throw new Error('Committed AnswerSubmission is missing its atomic payload/inbox/link facts.');
    }
    const payload = payloads[0];
    const inbox = inboxRows[0];
    const payloadLink = payloadLinks[0];
    const expectedContentObjectId = prepared?.metadata.id
      ?? this.contentStore.identity(command.content, command.contentType).id;
    if (
      submission.answer_bridge_id !== command.answerBridgeId
      || submission.turn_id !== command.sourceTurnId
      || submission.interrupted !== answerSubmissionOutcomeCode(outcome)
      || payload.id !== ids.answerPayloadId
      || payload.title !== (command.title ?? null)
      || payload.content_object_id !== expectedContentObjectId
      || inbox.id !== ids.inboxItemId
      || inbox.source_kind !== 'answer_submission'
      || inbox.source_id !== command.submissionId
      || payloadLink.id !== ids.inboxPayloadLinkId
      || payloadLink.inbox_item_id !== ids.inboxItemId
      || payloadLink.content_object_id !== expectedContentObjectId
      || bridge.child_execution_id === null
    ) throw new Error('Answer callback identity was replayed with different facts.');
    return answerResult(
      command,
      ids,
      false,
      true,
      bridge.current_submission_id !== command.submissionId
    );
  }

  private async listRows(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    return requireRows(barrier.snapshot[0], `${domain} list`);
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const barrier = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return barrier.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    return requireRow(await this.maybeGet(domain, id), `${domain} ${id}`);
  }

  private timestamp(): string {
    return requireIsoTimestamp(this.now(), 'Answer clock');
  }
}

/** RuntimeInbox destination/attempt state machine and parentHandling repository projection. */
export class RuntimeDeliveryControlPlane {
  private readonly now: () => string;
  private readonly automaticDeliveryRouter: AutomaticRuntimeDeliveryRouter;

  public constructor(
    private readonly database: RuntimeDatabase,
    contentStore: ContentAddressedStore,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.automaticDeliveryRouter = new AutomaticRuntimeDeliveryRouter(database, contentStore);
  }

  public async create(commandInput: RuntimeDeliveryCreateCommand): Promise<RuntimeDeliveryResult & {
    deduplicated: boolean;
    commitSeq?: string;
  }>;
  public async create(
    commandInput: RuntimeDeliveryCreateCommand,
    authoritySteps: RepositoryTransactionStep[]
  ): Promise<RuntimeDeliveryResult & { deduplicated: boolean; commitSeq?: string }>;
  public async create(
    commandInput: RuntimeDeliveryCreateCommand,
    authoritySteps: RepositoryTransactionStep[] = []
  ): Promise<RuntimeDeliveryResult & { deduplicated: boolean; commitSeq?: string }> {
    const command = normalizeDeliveryCommand(commandInput);
    const attemptSeq = 1n;
    const deliveryId = deliveryIdFor(command, attemptSeq);
    const existing = await this.maybeGet('RuntimeDelivery', deliveryId);
    if (existing) {
      await this.markInboxRouted(command.inboxItemId);
      return { ...(await this.summaryFromRow(existing)), deduplicated: true };
    }
    const inbox = await this.requireExisting('RuntimeInboxItem', command.inboxItemId);
    const conversation = await this.maybeGet('Conversation', command.targetConversationId);
    const targetTurn = command.targetTurnId
      ? await this.maybeGet('Turn', command.targetTurnId)
      : null;
    const targetGone = !conversation || (command.targetTurnId !== null && !targetTurn);
    if (targetTurn && targetTurn.conversation_id !== command.targetConversationId) {
      throw new Error('RuntimeDelivery target Turn does not belong to target Conversation.');
    }
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(command.inboxItemId, {
          source_kind: inbox.source_kind,
          state: inbox.state
        }),
        ...authoritySteps,
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({
          id: deliveryId,
          inbox_item_id: command.inboxItemId,
          target_conversation_id: command.targetConversationId,
          target_turn_id: command.targetTurnId,
          phase: command.phase,
          attempt_seq: attemptSeq,
          retry_of_delivery_id: null,
          state: targetGone ? 'failed' : 'pending',
          failure_reason: targetGone ? 'target-gone' : null,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').update(command.inboxItemId, {
          state: inbox.state === 'settled' ? 'settled' : 'routed',
          updated_at: now
        })
      ]);
      const row = await this.requireExisting('RuntimeDelivery', deliveryId);
      return { ...(await this.summaryFromRow(row)), deduplicated: false, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!isExpectedDeliveryIdentityConflict(error) && !isTransactionAssertionFailure(error)) throw error;
      const raced = await this.findDeliveryByIdentity(command, attemptSeq);
      if (!raced) throw error;
      await this.markInboxRouted(command.inboxItemId);
      return { ...(await this.summaryFromRow(raced)), deduplicated: true };
    }
  }

  private async markInboxRouted(inboxItemId: string): Promise<void> {
    const inbox = await this.requireExisting('RuntimeInboxItem', inboxItemId);
    if (inbox.state === 'routed' || inbox.state === 'settled') return;
    if (inbox.state !== 'available') {
      throw new Error(`RuntimeInboxItem ${inboxItemId} has unsupported routing state ${String(inbox.state)}.`);
    }
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(inboxItemId, { state: 'available' }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').update(inboxItemId, {
          state: 'routed',
          updated_at: now
        })
      ]);
    } catch (error) {
      if (!isTransactionAssertionFailure(error)) throw error;
      const raced = await this.requireExisting('RuntimeInboxItem', inboxItemId);
      if (raced.state !== 'routed' && raced.state !== 'settled') throw error;
    }
  }

  /** Resolves and commits one automatic delivery under the same source-Turn authority CAS. */
  public async createAutomatic(input: {
    inboxItemId: string;
    targetConversationId: string;
    sourceTurnId: string;
  }): Promise<RuntimeDeliveryResult & { deduplicated: boolean; commitSeq?: string }> {
    const inboxItemId = requirePhaseFId(input.inboxItemId, 'inboxItemId');
    const targetConversationId = requirePhaseFId(input.targetConversationId, 'targetConversationId');
    const sourceTurnId = requirePhaseFId(input.sourceTurnId, 'sourceTurnId');
    const decision = await this.automaticDeliveryRouter.resolve({
      inboxItemId,
      targetConversationId,
      sourceTurnId
    });
    return this.create({
      inboxItemId,
      targetConversationId,
      targetTurnId: decision.targetTurnId,
      phase: decision.phase
    }, decision.authoritySteps);
  }

  public async redeliver(failedDeliveryIdInput: string): Promise<RuntimeDeliveryResult & {
    retryOfDeliveryId: string;
    commitSeq: string;
  }> {
    const failedDeliveryId = requirePhaseFId(failedDeliveryIdInput, 'failedDeliveryId');
    const failed = await this.requireExisting('RuntimeDelivery', failedDeliveryId);
    if (failed.state !== 'failed') throw new Error('Only a failed RuntimeDelivery can be redelivered.');
    const phase = requireDeliveryPhase(failed.phase);
    const peers = await listAllDomainRows(this.database, 'RuntimeDelivery', {
      inbox_item_id: failed.inbox_item_id,
      target_conversation_id: failed.target_conversation_id
    });
    const nextAttempt = peers.reduce((maximum, row) => {
      const attempt = requirePositiveInteger(row.attempt_seq, 'RuntimeDelivery.attempt_seq');
      return attempt > maximum ? attempt : maximum;
    }, 0n) + 1n;
    const command = normalizeDeliveryCommand({
      inboxItemId: failed.inbox_item_id as string,
      targetConversationId: failed.target_conversation_id as string,
      targetTurnId: failed.target_turn_id as string | null,
      phase
    });
    const newId = deliveryIdFor(command, nextAttempt);
    const now = this.timestamp();
    const conversation = await this.maybeGet('Conversation', command.targetConversationId);
    const targetTurn = command.targetTurnId ? await this.maybeGet('Turn', command.targetTurnId) : null;
    const targetGone = !conversation || (command.targetTurnId !== null && !targetTurn);
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(failedDeliveryId, {
        state: 'failed',
        attempt_seq: failed.attempt_seq
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({
        id: newId,
        inbox_item_id: command.inboxItemId,
        target_conversation_id: command.targetConversationId,
        target_turn_id: command.targetTurnId,
        phase,
        attempt_seq: nextAttempt,
        retry_of_delivery_id: failedDeliveryId,
        state: targetGone ? 'failed' : 'pending',
        failure_reason: targetGone ? 'target-gone' : null,
        created_at: now,
        updated_at: now
      })
    ]);
    const row = await this.requireExisting('RuntimeDelivery', newId);
    return { ...(await this.summaryFromRow(row)), retryOfDeliveryId: failedDeliveryId, commitSeq: commit.commitSeq };
  }

  public async advance(deliveryIdInput: string): Promise<RuntimeDeliveryAdvanceResult> {
    const deliveryId = requirePhaseFId(deliveryIdInput, 'deliveryId');
    const delivery = await this.requireExisting('RuntimeDelivery', deliveryId);
    requireDeliveryState(delivery.state);
    if (delivery.state !== 'pending') return { ...(await this.summaryFromRow(delivery)), changed: false };
    const phase = requireDeliveryPhase(delivery.phase);
    const conversation = await this.maybeGet(
      'Conversation',
      requirePhaseFId(delivery.target_conversation_id, 'RuntimeDelivery.target_conversation_id')
    );
    if (!conversation) return this.failTargetGone(delivery);
    const targetTurn = delivery.target_turn_id === null
      ? null
      : await this.maybeGet('Turn', requirePhaseFId(delivery.target_turn_id, 'RuntimeDelivery.target_turn_id'));
    if (delivery.target_turn_id !== null && !targetTurn) return this.failTargetGone(delivery);

    if (phase === 'notify_only') {
      return { ...(await this.summaryFromRow(delivery)), changed: false };
    }
    if (phase === 'next_turn' && targetTurn === null) {
      return { ...(await this.summaryFromRow(delivery)), changed: false };
    }
    if (!targetTurn) throw new Error('current_turn delivery requires a target Turn.');
    if (targetTurn.conversation_id !== conversation.id) return this.failTargetGone(delivery);
    const decision = await this.automaticDeliveryRouter.resolve({
      inboxItemId: requirePhaseFId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id'),
      targetConversationId: requirePhaseFId(conversation.id, 'Conversation.id'),
      sourceTurnId: requirePhaseFId(targetTurn.id, 'Turn.id')
    });
    if (
      targetTurn.status === ACTIVE_TURN
      && decision.phase === 'current_turn'
      && decision.targetTurnId === targetTurn.id
    ) return this.inject(delivery, targetTurn, decision.authoritySteps);
    if (targetTurn.status !== ACTIVE_TURN && targetTurn.status !== TERMINATED_TURN) {
      throw new Error(`RuntimeDelivery target Turn has unsupported status ${String(targetTurn.status)}.`);
    }
    return this.retargetWithDecision(delivery, decision);
  }

  /**
   * Called before a new Turn transaction; returned steps write back target + inject atomically.
   * `startingDeliveryId` names the delivery a runtime continuation was admitted for: only that
   * Turn consumes a cross-conversation followup, every other Turn leaves it waiting.
   */
  public async prepareNextTurnDeliverySteps(
    conversationIdInput: string,
    turnIdInput: string,
    nowInput: string,
    startingDeliveryIdInput?: string | null
  ): Promise<RepositoryTransactionStep[]> {
    const conversationId = requirePhaseFId(conversationIdInput, 'conversationId');
    const turnId = requirePhaseFId(turnIdInput, 'turnId');
    const now = requireIsoTimestamp(nowInput, 'now');
    const startingDeliveryId = startingDeliveryIdInput == null
      ? null
      : requirePhaseFId(startingDeliveryIdInput, 'startingDeliveryId');
    const deliveries = (await listAllDomainRows(this.database, 'RuntimeDelivery', {
      target_conversation_id: conversationId,
      target_turn_id: null,
      phase: 'next_turn',
      state: 'pending'
    })).sort((left, right) =>
      String(left.created_at).localeCompare(String(right.created_at))
      || String(left.id).localeCompare(String(right.id))
    );
    const steps: RepositoryTransactionStep[] = [];
    for (const delivery of deliveries) {
      const inbox = await this.requireExisting('RuntimeInboxItem', String(delivery.inbox_item_id));
      if (inbox.source_kind === 'collaboration_message') {
        const sources = await this.listRows('CollaborationMessageSourceLink', { message_id: inbox.source_id }, 2);
        if (sources[0]?.source_kind === 'board') {
          steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(String(delivery.id), { state: 'pending', phase: 'next_turn', target_turn_id: null }), DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(String(delivery.id), { state: 'failed', failure_reason: 'board-notification-expired', updated_at: now }));
          continue;
        }
        // A peer's task starts its own Turn; a plain message joins whichever Turn comes next.
        if (delivery.id !== startingDeliveryId && await isCrossConversationFollowup(this.database, String(inbox.source_id))) continue;
      }
      const contentObjectId = await this.contentObjectIdForInbox(delivery.inbox_item_id as string);
      if (!contentObjectId) {
        steps.push(
          DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, {
            state: 'pending', phase: 'next_turn', target_turn_id: null
          }),
          DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(delivery.id as string, {
            phase: 'notify_only',
            updated_at: now
          })
        );
        continue;
      }
      steps.push(...injectionSteps(delivery, turnId, contentObjectId, now, true, await this.collaborationRequestInjectionSteps(delivery, turnId, now)));
    }
    return steps;
  }

  public async acknowledgeNotification(deliveryIdInput: string): Promise<RuntimeDeliveryAdvanceResult> {
    const delivery = await this.requireExisting(
      'RuntimeDelivery',
      requirePhaseFId(deliveryIdInput, 'deliveryId')
    );
    if (delivery.phase !== 'notify_only') throw new Error('Only notify_only delivery can be acknowledged without input injection.');
    if (delivery.state !== 'pending') return { ...(await this.summaryFromRow(delivery)), changed: false };
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, {
          state: 'pending', phase: 'notify_only'
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(delivery.id as string, {
          state: 'consumed',
          failure_reason: null,
          updated_at: now
        })
      ]);
      const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
      return { ...(await this.summaryFromRow(latest)), changed: true, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!isTransactionAssertionFailure(error)) throw error;
      const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
      if (latest.phase === 'notify_only' && latest.state === 'consumed') {
        return { ...(await this.summaryFromRow(latest)), changed: false };
      }
      throw error;
    }
  }

  /** Executor ACK for the exact injected PendingTurnInput; unrelated inputs cannot affect handling. */
  public async markInputHandled(pendingTurnInputIdInput: string): Promise<RuntimeDeliveryResult & {
    changed: boolean;
    commitSeq?: string;
  }> {
    const pendingTurnInputId = requirePhaseFId(pendingTurnInputIdInput, 'pendingTurnInputId');
    const links = await this.listRows('RuntimeDeliveryInputLink', {
      pending_turn_input_id: pendingTurnInputId
    }, 2);
    if (links.length !== 1) throw new Error('PendingTurnInput must have exactly one RuntimeDeliveryInputLink.');
    const link = links[0];
    const delivery = await this.requireExisting('RuntimeDelivery', link.delivery_id as string);
    if (delivery.state !== 'consumed') throw new Error('RuntimeDeliveryInputLink can only be handled after delivery consumption.');
    if (link.handled_at !== null) return { ...(await this.summaryFromRow(delivery, link)), changed: false };
    const input = await this.requireExisting('PendingTurnInput', pendingTurnInputId);
    const now = this.timestamp();
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, { state: 'consumed' }),
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').assert(link.id as string, {
        delivery_id: delivery.id,
        pending_turn_input_id: pendingTurnInputId,
        handled_at: null
      }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').assert(pendingTurnInputId, {
        turn_id: input.turn_id,
        state: input.state
      }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').update(pendingTurnInputId, {
        state: 'consumed',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').update(link.id as string, {
        handled_at: now,
        updated_at: now
      })
    ]);
    const latestLink = await this.requireExisting('RuntimeDeliveryInputLink', link.id as string);
    return { ...(await this.summaryFromRow(delivery, latestLink)), changed: true, commitSeq: commit.commitSeq };
  }

  /** One SQLite snapshot transaction and repository-owned parentHandling derivation. */
  public async summary(deliveryIdInput: string): Promise<RuntimeDeliveryResult> {
    const deliveryId = requirePhaseFId(deliveryIdInput, 'deliveryId');
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').get(deliveryId),
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').list({
        where: { delivery_id: deliveryId },
        limit: 2
      })
    ]);
    const delivery = requireRow(barrier.snapshot[0], `RuntimeDelivery ${deliveryId}`);
    const links = requireRows(barrier.snapshot[1], 'RuntimeDeliveryInputLink summary');
    if (links.length > 1) throw new Error('RuntimeDelivery has multiple input links.');
    return this.summaryFromRow(delivery, links[0] ?? null);
  }

  /**
   * Read-only Runtime Delivery -> model envelope projection.
   *
   * The caller supplies bytes already read through the verified CAS path. This method only joins
   * immutable delivery/source identities and never consumes Inbox, Delivery, or PendingTurnInput.
   */
  public async projectInputForModel(
    commandInput: RuntimeDeliveryModelProjectionCommand
  ): Promise<RuntimeDeliveryModelProjection | null> {
    const pendingTurnInputId = requirePhaseFId(
      commandInput.pendingTurnInputId,
      'pendingTurnInputId'
    );
    const contentObjectId = requirePhaseFId(commandInput.contentObjectId, 'contentObjectId');
    const contentType = requirePhaseFText(commandInput.contentType, 'contentType');
    const contentBytes = typeof commandInput.content === 'string'
      ? Buffer.from(commandInput.content, 'utf8')
      : Buffer.from(commandInput.content);
    const input = await this.requireExisting('PendingTurnInput', pendingTurnInputId);
    if (input.input_kind !== 'runtime_delivery') {
      throw new Error('Only a runtime_delivery PendingTurnInput has a Runtime Delivery model projection.');
    }
    if (input.content_object_id !== contentObjectId) {
      throw new Error('Runtime Delivery projection content conflicts with PendingTurnInput.');
    }
    const inputLinks = await this.listRows('RuntimeDeliveryInputLink', {
      pending_turn_input_id: pendingTurnInputId
    }, 2);
    if (inputLinks.length !== 1) {
      throw new Error('Runtime Delivery model projection requires exactly one input link.');
    }
    const inputLink = inputLinks[0];
    const deliveryId = requirePhaseFId(
      inputLink.delivery_id,
      'RuntimeDeliveryInputLink.delivery_id'
    );
    const delivery = await this.requireExisting('RuntimeDelivery', deliveryId);
    const phase = requireDeliveryPhase(delivery.phase);
    if (!runtimeDeliveryPhaseAllowsModelInput(phase)) return null;
    if (delivery.state !== 'consumed') {
      throw new Error('Runtime Delivery must be consumed by an input before model projection.');
    }
    const targetTurnId = requirePhaseFId(input.turn_id, 'PendingTurnInput.turn_id');
    if (delivery.target_turn_id !== targetTurnId) {
      throw new Error('Runtime Delivery target conflicts with its PendingTurnInput.');
    }
    const inboxItemId = requirePhaseFId(
      delivery.inbox_item_id,
      'RuntimeDelivery.inbox_item_id'
    );
    const inbox = await this.requireExisting('RuntimeInboxItem', inboxItemId);
    const payloadLinks = await this.listRows('RuntimeInboxPayloadLink', {
      inbox_item_id: inboxItemId
    }, 2);
    if (payloadLinks.length !== 1 || payloadLinks[0].content_object_id !== contentObjectId) {
      throw new Error('Runtime Delivery model projection requires its exact Inbox payload.');
    }
    const metadata = await this.requireExisting('ContentObject', contentObjectId) as ContentObjectMetadata;
    if (metadata.content_type !== contentType || metadata.byte_length !== BigInt(contentBytes.byteLength)) {
      throw new Error('Runtime Delivery projection bytes conflict with ContentObject metadata.');
    }
    const deliveredAt = requireIsoTimestamp(
      input.created_at,
      'PendingTurnInput.created_at'
    );
    if (inbox.source_kind === 'collaboration_message') {
      if (contentType !== 'text/vnd.limcode.collaboration-message') throw new Error('Collaboration Runtime Delivery has an unexpected content type.');
      const messageId = requirePhaseFId(inbox.source_id, 'Collaboration RuntimeInboxItem.source_id');
      const [message, sources, targets, payloads, replies] = await Promise.all([
        this.requireExisting('CollaborationMessage', messageId), this.listRows('CollaborationMessageSourceLink', { message_id: messageId }, 2), this.listRows('CollaborationMessageTargetLink', { message_id: messageId }, 2), this.listRows('CollaborationMessagePayloadLink', { message_id: messageId }, 2), this.listRows('CollaborationMessageReplyLink', { message_id: messageId }, 2)
      ]);
      if (sources.length !== 1 || targets.length !== 1 || targets[0].inbox_item_id !== inboxItemId || targets[0].conversation_id !== delivery.target_conversation_id || payloads.length !== 1 || payloads[0].content_object_id !== contentObjectId) throw new Error('Collaboration Runtime Delivery has conflicting identity links.');
      let board: { postId: string; channelId: string; threadId: string } | undefined;
      if (sources[0].source_kind === 'board') {
        const postId = requirePhaseFId(sources[0].board_post_id, 'Board notification post');
        const [channels, replyLinks] = await Promise.all([this.listRows('CollaborationBoardPostChannelLink', { post_id: postId }, 2), this.listRows('CollaborationBoardReplyLink', { post_id: postId }, 2)]);
        if (channels.length !== 1) throw new Error('Board notification post has no unique channel.');
        board = { postId, channelId: String(channels[0].channel_id), threadId: replyLinks[0] ? String(replyLinks[0].thread_id) : postId };
      }
      const sourceConversationId = String(sources[0].conversation_id);
      const targetConversationId = String(targets[0].conversation_id);
      // A team always has a child task on one side; cross-conversation tools join two top-level
      // conversations. A deleted sender keeps its ref but loses its title.
      const [sender, sourceChildren, targetChildren] = await Promise.all([
        this.maybeGet('Conversation', sourceConversationId),
        this.listRows('ChildExecution', { child_conversation_id: sourceConversationId }, 1),
        this.listRows('ChildExecution', { child_conversation_id: targetConversationId }, 1)
      ]);
      const senderKind = sources[0].source_kind === 'board' || sourceChildren.length > 0 || targetChildren.length > 0
        ? 'team_agent' as const : 'other_conversation' as const;
      const senderTitle = sender ? displayConversationTitle({ id: sourceConversationId, title: String(sender.title), maxLength: 80 }) : null;
      return projectRuntimeDeliveryForModel({ ...(board ? { board } : {}), kind: 'collaboration_message', phase, deliveryId, inboxItemId, targetTurnId, deliveredAt, messageId, sourceConversationId, targetConversationId, sourceKind: String(sources[0].source_kind), mode: message.mode as 'message' | 'followup', replyToMessageId: replies[0] ? String(replies[0].request_message_id) : null, content: contentBytes.toString('utf8'),
        failureReply: sources[0].source_kind === 'completion' && sources[0].turn_id === null, senderKind, senderTitle });
    }
    if (inbox.source_kind === 'process_receipt') {
      if (contentType !== PROCESS_COMPLETION_MODEL_SOURCE_CONTENT_TYPE) {
        throw new Error('Process completion Runtime Delivery has an unexpected content type.');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(contentBytes.toString('utf8'));
      } catch {
        throw new TypeError('Process completion Runtime Delivery payload must be valid JSON.');
      }
      const processReceiptId = requirePhaseFId(
        inbox.source_id,
        'Process completion RuntimeInboxItem.source_id'
      );
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('Process completion Runtime Delivery payload must be an object.');
      }
      const processId = requirePhaseFId(
        (payload as Record<string, unknown>).processId,
        'Process completion payload.processId'
      );
      return projectRuntimeDeliveryForModel({
        kind: 'process_completion',
        phase,
        deliveryId,
        inboxItemId,
        targetTurnId,
        deliveredAt,
        processId,
        processReceiptId,
        content: payload
      });
    }
    if (inbox.source_kind !== 'answer_submission') {
      throw new Error(`Unsupported Runtime Delivery model source ${String(inbox.source_kind)}.`);
    }
    const submissionId = requirePhaseFId(
      inbox.source_id,
      'Answer RuntimeInboxItem.source_id'
    );
    const submission = await this.requireExisting('AnswerSubmission', submissionId);
    const answerBridgeId = requirePhaseFId(
      submission.answer_bridge_id,
      'AnswerSubmission.answer_bridge_id'
    );
    const bridge = await this.requireExisting('AnswerBridge', answerBridgeId);
    const childExecutionId = requirePhaseFId(
      bridge.child_execution_id,
      'AnswerBridge.child_execution_id'
    );
    const payloads = await this.listRows('AnswerPayload', { submission_id: submissionId }, 2);
    if (payloads.length !== 1 || payloads[0].content_object_id !== contentObjectId) {
      throw new Error('Answer Runtime Delivery model projection requires its exact AnswerPayload.');
    }
    const rawContent = contentBytes.toString('utf8');
    const isMessageContent = contentType === 'application/vnd.limcode.message+json';
    const content = isMessageContent
      ? requireVisibleAssistantTextForProjection(rawContent)
      : rawContent;
    const projectedContentType = isMessageContent ? 'text/plain' : contentType;
    const sourceTurnId = requirePhaseFId(submission.turn_id, 'AnswerSubmission.turn_id');
    const title = payloads[0].title === null
      ? null
      : requirePhaseFText(payloads[0].title, 'AnswerPayload.title');
    const outcome = answerSubmissionOutcome(submission, childExecutionId);
    if (outcome === 'failed') {
      return projectRuntimeDeliveryForModel({
        kind: 'child_failure',
        status: 'failed',
        phase,
        deliveryId,
        inboxItemId,
        targetTurnId,
        deliveredAt,
        childExecutionId,
        answerBridgeId,
        submissionId,
        sourceTurnId,
        title,
        contentType: projectedContentType,
        content
      });
    }
    return projectRuntimeDeliveryForModel({
      kind: 'child_answer',
      status: outcome,
      phase,
      deliveryId,
      inboxItemId,
      targetTurnId,
      deliveredAt,
      childExecutionId,
      answerBridgeId,
      submissionId,
      sourceTurnId,
      title,
      contentType: projectedContentType,
      content
    });
  }

  private async collaborationRequestInjectionSteps(delivery: DomainRow, turnId: string, now: string): Promise<RepositoryTransactionStep[]> {
    const inbox = await this.requireExisting('RuntimeInboxItem', String(delivery.inbox_item_id));
    if (inbox.source_kind !== 'collaboration_message') return [];
    const requests = await this.listRows('CollaborationRequest', { message_id: inbox.source_id }, 2);
    if (!requests.length) return [];
    if (requests.length !== 1) throw new Error('Collaboration message has duplicate requests.');
    const request = requests[0];
    return [DOMAIN_REPOSITORIES.domain('CollaborationRequest').assert(String(request.id), { state: 'pending', message_id: inbox.source_id }), DOMAIN_REPOSITORIES.domain('CollaborationRequestTurnLink').insert({ id: stablePhaseFId('collaboration_request_turn', String(request.id)), request_id: request.id, turn_id: turnId, created_at: now })];
  }

  private async inject(
    delivery: DomainRow,
    targetTurn: DomainRow,
    authoritySteps: RepositoryTransactionStep[]
  ): Promise<RuntimeDeliveryAdvanceResult> {
    const contentObjectId = await this.contentObjectIdForInbox(delivery.inbox_item_id as string);
    if (!contentObjectId) return this.failTargetGone(delivery);
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction(injectionSteps(
        delivery,
        targetTurn.id as string,
        contentObjectId,
        now,
        false,
        [...authoritySteps, ...await this.collaborationRequestInjectionSteps(delivery, String(targetTurn.id), now)]
      ));
      const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
      return { ...(await this.summaryFromRow(latest)), changed: true, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!isExpectedDeliveryInjectionRace(error)) throw error;
      const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
      if (latest.state === 'consumed') return { ...(await this.summaryFromRow(latest)), changed: false };
      if (latest.state === 'pending') return this.advance(latest.id as string);
      return { ...(await this.summaryFromRow(latest)), changed: false };
    }
  }

  private async retargetWithDecision(
    delivery: DomainRow,
    decision: AutomaticRuntimeDeliveryDecision
  ): Promise<RuntimeDeliveryAdvanceResult> {
    const now = this.timestamp();
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, {
        state: 'pending',
        phase: delivery.phase,
        target_turn_id: delivery.target_turn_id
      }),
      ...decision.authoritySteps,
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(delivery.id as string, {
        phase: decision.phase,
        target_turn_id: decision.targetTurnId,
        ...(decision.reason === 'collaboration_notification_expired' ? { state: 'failed', failure_reason: 'board-notification-expired' } : {}),
        updated_at: now
      })
    ]);
    const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
    return { ...(await this.summaryFromRow(latest)), changed: true, commitSeq: commit.commitSeq };
  }

  private async failTargetGone(delivery: DomainRow): Promise<RuntimeDeliveryAdvanceResult> {
    const now = this.timestamp();
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, { state: 'pending' }),
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(delivery.id as string, {
        state: 'failed',
        failure_reason: 'target-gone',
        updated_at: now
      })
    ]);
    const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
    return { ...(await this.summaryFromRow(latest)), changed: true, commitSeq: commit.commitSeq };
  }

  private async contentObjectIdForInbox(inboxItemId: string): Promise<string | null> {
    await this.requireExisting('RuntimeInboxItem', inboxItemId);
    const links = await this.listRows('RuntimeInboxPayloadLink', { inbox_item_id: inboxItemId }, 2);
    if (links.length !== 1) throw new Error('RuntimeInboxItem must resolve exactly one RuntimeInboxPayloadLink.');
    return requirePhaseFId(links[0].content_object_id, 'RuntimeInboxPayloadLink.content_object_id');
  }

  private async findDeliveryByIdentity(
    command: ReturnType<typeof normalizeDeliveryCommand>,
    attemptSeq: bigint
  ): Promise<DomainRow | null> {
    const where: DomainRow = {
      inbox_item_id: command.inboxItemId,
      target_conversation_id: command.targetConversationId,
      attempt_seq: attemptSeq
    };
    const rows = await this.listRows('RuntimeDelivery', where, 2);
    if (rows.length > 1) throw new Error('RuntimeDelivery logical attempt identity is violated.');
    return rows[0] ?? null;
  }

  private async summaryFromRow(delivery: DomainRow, suppliedLink?: DomainRow | null): Promise<RuntimeDeliveryResult> {
    requireDeliveryState(delivery.state);
    const phase = requireDeliveryPhase(delivery.phase);
    let link = suppliedLink;
    if (link === undefined) {
      const links = await this.listRows('RuntimeDeliveryInputLink', { delivery_id: delivery.id }, 2);
      if (links.length > 1) throw new Error('RuntimeDelivery has multiple RuntimeDeliveryInputLinks.');
      link = links[0] ?? null;
    }
    return {
      delivery,
      inputLink: link,
      parentHandlingState: deriveParentHandlingState({
        state: delivery.state as RuntimeDeliveryState,
        phase,
        inputLink: link ?? null
      })
    };
  }

  private async listRows(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    return requireRows(barrier.snapshot[0], `${domain} list`);
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const barrier = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return barrier.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    return requireRow(await this.maybeGet(domain, id), `${domain} ${id}`);
  }

  private timestamp(): string {
    return requireIsoTimestamp(this.now(), 'RuntimeDelivery clock');
  }
}

export function deriveParentHandlingState(input: {
  state: RuntimeDeliveryState;
  phase: RuntimeDeliveryPhase;
  inputLink: DomainRow | null;
}): ParentHandlingState {
  if (input.state === 'pending' || input.state === 'failed') return 'unhandled';
  if (input.phase === 'notify_only' && input.inputLink === null) return 'not_applicable';
  if ((input.phase === 'current_turn' || input.phase === 'next_turn') && input.inputLink) {
    return input.inputLink.handled_at === null ? 'unhandled' : 'handled';
  }
  throw new Error('Consumed RuntimeDelivery has an invalid phase/InputLink combination.');
}

function normalizeAnswerCommand(command: AnswerSubmitCommand) {
  if (typeof command.content !== 'string' && !(command.content instanceof Uint8Array)) {
    throw new TypeError('Answer content must be text or bytes.');
  }
  return {
    answerBridgeId: requirePhaseFId(command.answerBridgeId, 'answerBridgeId'),
    submissionId: requirePhaseFId(command.submissionId, 'submissionId'),
    sourceTurnId: requirePhaseFId(command.sourceTurnId, 'sourceTurnId'),
    ...(typeof command.title === 'string' && command.title.trim() ? { title: command.title.trim() } : {}),
    content: command.content,
    contentType: command.contentType === undefined
      ? 'text/plain'
      : requirePhaseFText(command.contentType, 'contentType')
  };
}

function answerIds(answerBridgeId: string, submissionId: string) {
  const inboxItemId = stablePhaseFId('runtime_inbox_item', 'answer', answerBridgeId, submissionId);
  return {
    answerPayloadId: stablePhaseFId('answer_payload', answerBridgeId, submissionId),
    inboxItemId,
    inboxPayloadLinkId: stablePhaseFId('runtime_inbox_payload_link', inboxItemId)
  };
}

function answerDedupeKey(answerBridgeId: string, submissionId: string): string {
  return `answer:${answerBridgeId}:${submissionId}`;
}

function answerSubmissionOutcomeCode(outcome: AnswerSubmissionOutcome): bigint {
  return outcome === 'interrupted' ? 1n : 0n;
}

function answerSubmissionOutcome(
  submission: DomainRow,
  childExecutionId: string
): AnswerSubmissionOutcome {
  if (submission.interrupted === 1n) return 'interrupted';
  if (submission.interrupted !== 0n) {
    throw new Error(`AnswerSubmission has unsupported interrupted flag ${String(submission.interrupted)}.`);
  }
  const sourceTurnId = requirePhaseFId(submission.turn_id, 'AnswerSubmission.turn_id');
  const expectedFailureId = stablePhaseFId(
    'answer_submission',
    'child-drive-failed',
    childExecutionId,
    sourceTurnId
  );
  return submission.id === expectedFailureId ? 'failed' : 'submitted';
}

function answerAuthoritySteps(
  command: ReturnType<typeof normalizeAnswerCommand>,
  authority: AnswerSubmissionAuthority
): RepositoryTransactionStep[] {
  const common: RepositoryTransactionStep[] = [
    DOMAIN_REPOSITORIES.domain('ChildExecution').assert(
      requirePhaseFId(authority.childExecution.id, 'ChildExecution.id'),
      { status: authority.childExecution.status }
    ),
    DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assert(
      requirePhaseFId(authority.turnLink.id, 'ChildExecutionTurnLink.id'),
      {
        child_execution_id: authority.childExecution.id,
        turn_id: command.sourceTurnId,
        turn_seq: authority.turnLink.turn_seq
      }
    ),
    DOMAIN_REPOSITORIES.domain('Turn').assert(command.sourceTurnId, {
      status: authority.turn.status
    })
  ];
  if (!authority.activeTurnLink) throw new Error('Active answer authority lost its ActiveTurnLink.');
  common.push(
    DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: command.sourceTurnId }),
    DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(
      requirePhaseFId(authority.activeTurnLink.id, 'ChildExecutionActiveTurnLink.id'),
      {
        child_execution_id: authority.childExecution.id,
        turn_id: command.sourceTurnId
      }
    )
  );
  return common;
}

function interruptedAnswerAuthoritySteps(
  command: ReturnType<typeof normalizeAnswerCommand>,
  authority: AnswerSubmissionAuthority,
  exactTurnLinkIds: string[]
): RepositoryTransactionStep[] {
  if (!authority.termination) throw new Error('Interrupted answer authority lost its TurnTermination.');
  const childExecutionId = requirePhaseFId(authority.childExecution.id, 'ChildExecution.id');
  const childStatus = requireChildExecutionStatus(authority.childExecution.status);
  if (childStatus !== 'interrupting' && childStatus !== 'interrupted') {
    throw new Error('Interrupted answer authority requires an interrupted ChildExecution.');
  }
  return [
    DOMAIN_REPOSITORIES.domain('ChildExecution').assert(childExecutionId, {
      status: childStatus
    }),
    DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assertExactIds(
      { child_execution_id: childExecutionId },
      exactTurnLinkIds
    ),
    DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assert(
      requirePhaseFId(authority.turnLink.id, 'ChildExecutionTurnLink.id'),
      {
        child_execution_id: childExecutionId,
        turn_id: command.sourceTurnId,
        turn_seq: authority.turnLink.turn_seq
      }
    ),
    DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertNone({
      child_execution_id: childExecutionId
    }),
    DOMAIN_REPOSITORIES.domain('Turn').assert(command.sourceTurnId, {
      status: TERMINATED_TURN
    }),
    DOMAIN_REPOSITORIES.domain('TurnTermination').assert(
      requirePhaseFId(authority.termination.id, 'TurnTermination.id'),
      {
        turn_id: command.sourceTurnId,
        terminal_status: authority.termination.terminal_status
      }
    )
  ];
}

function failedAnswerAuthoritySteps(
  command: ReturnType<typeof normalizeAnswerCommand>,
  authority: AnswerSubmissionAuthority,
  exactTurnLinkIds: string[]
): RepositoryTransactionStep[] {
  if (!authority.termination || authority.termination.terminal_status !== 'failed') {
    throw new Error('Failed answer authority requires a failed TurnTermination.');
  }
  const childExecutionId = requirePhaseFId(authority.childExecution.id, 'ChildExecution.id');
  const activeTurnSteps = authority.activeTurnLink
    ? [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(
        requirePhaseFId(authority.activeTurnLink.id, 'ChildExecutionActiveTurnLink.id'),
        { child_execution_id: childExecutionId, turn_id: command.sourceTurnId }
      )]
    : [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertNone({
        child_execution_id: childExecutionId
      })];
  return [
    DOMAIN_REPOSITORIES.domain('ChildExecution').assert(childExecutionId, {
      status: authority.childExecution.status
    }),
    DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assertExactIds(
      { child_execution_id: childExecutionId },
      exactTurnLinkIds
    ),
    DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assert(
      requirePhaseFId(authority.turnLink.id, 'ChildExecutionTurnLink.id'),
      {
        child_execution_id: childExecutionId,
        turn_id: command.sourceTurnId,
        turn_seq: authority.turnLink.turn_seq
      }
    ),
    ...activeTurnSteps,
    DOMAIN_REPOSITORIES.domain('Turn').assert(command.sourceTurnId, {
      status: TERMINATED_TURN
    }),
    DOMAIN_REPOSITORIES.domain('TurnTermination').assert(
      requirePhaseFId(authority.termination.id, 'TurnTermination.id'),
      { turn_id: command.sourceTurnId, terminal_status: 'failed' }
    )
  ];
}

function answerFactSteps(
  command: ReturnType<typeof normalizeAnswerCommand>,
  ids: ReturnType<typeof answerIds>,
  bridge: DomainRow,
  payloadContent: PreparedContentObject,
  now: string,
  outcome: AnswerSubmissionOutcome
): RepositoryTransactionStep[] {
  const interrupted = outcome === 'interrupted';
  return [
    DOMAIN_REPOSITORIES.domain('AnswerBridge').assert(command.answerBridgeId, {
      child_execution_id: bridge.child_execution_id,
      status: bridge.status,
      current_submission_id: interrupted ? null : bridge.current_submission_id
    }),
    ...preparedContentObjectSteps([payloadContent], 'answer_payload'),
    DOMAIN_REPOSITORIES.domain('AnswerSubmission').insertWithNextSequence({
      id: command.submissionId,
      answer_bridge_id: command.answerBridgeId,
      turn_id: command.sourceTurnId,
      interrupted: answerSubmissionOutcomeCode(outcome).toString(),
      created_at: now
    }, {
      column: 'submission_seq',
      scope: { answer_bridge_id: command.answerBridgeId }
    }),
    DOMAIN_REPOSITORIES.domain('AnswerPayload').insert({
      id: ids.answerPayloadId,
      submission_id: command.submissionId,
      title: command.title ?? null,
      content_object_id: payloadContent.metadata.id,
      byte_length: payloadContent.metadata.byte_length,
      created_at: now
    }),
    DOMAIN_REPOSITORIES.domain('AnswerBridge').update(command.answerBridgeId, {
      current_submission_id: command.submissionId,
      status: interrupted ? 'interrupted' : 'submitted',
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({
      id: ids.inboxItemId,
      dedupe_key: answerDedupeKey(command.answerBridgeId, command.submissionId),
      source_kind: 'answer_submission',
      source_id: command.submissionId,
      state: 'available',
      created_at: now,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeInboxPayloadLink').insert({
      id: ids.inboxPayloadLinkId,
      inbox_item_id: ids.inboxItemId,
      content_object_id: payloadContent.metadata.id,
      created_at: now
    })
  ];
}

function answerResult(
  command: ReturnType<typeof normalizeAnswerCommand>,
  ids: ReturnType<typeof answerIds>,
  foregroundSettled: boolean,
  deduplicated: boolean,
  historicalReplay: boolean,
  commitSeq?: string
): AnswerSubmitResult {
  return {
    answerBridgeId: command.answerBridgeId,
    submissionId: command.submissionId,
    answerPayloadId: ids.answerPayloadId,
    inboxItemId: ids.inboxItemId,
    foregroundSettled,
    deduplicated,
    historicalReplay,
    ...(commitSeq ? { commitSeq } : {})
  };
}

function normalizeDeliveryCommand(command: RuntimeDeliveryCreateCommand) {
  const phase = requireDeliveryPhase(command.phase);
  const targetTurnId = command.targetTurnId === undefined || command.targetTurnId === null
    ? null
    : requirePhaseFId(command.targetTurnId, 'targetTurnId');
  if (phase === 'current_turn' && targetTurnId === null) {
    throw new TypeError('current_turn RuntimeDelivery requires targetTurnId.');
  }
  return {
    inboxItemId: requirePhaseFId(command.inboxItemId, 'inboxItemId'),
    targetConversationId: requirePhaseFId(command.targetConversationId, 'targetConversationId'),
    targetTurnId,
    phase
  };
}

function deliveryIdFor(command: ReturnType<typeof normalizeDeliveryCommand>, attemptSeq: bigint): string {
  return stablePhaseFId(
    'runtime_delivery',
    command.inboxItemId,
    command.targetConversationId,
    command.targetTurnId,
    command.phase,
    attemptSeq.toString()
  );
}

function injectionSteps(
  delivery: DomainRow,
  targetTurnId: string,
  contentObjectId: string,
  now: string,
  writebackTarget: boolean,
  authoritySteps: RepositoryTransactionStep[]
): RepositoryTransactionStep[] {
  const deliveryId = requirePhaseFId(delivery.id, 'RuntimeDelivery.id');
  const inputId = stablePhaseFId('pending_turn_input', 'runtime-delivery', deliveryId);
  const linkId = stablePhaseFId('runtime_delivery_input_link', deliveryId);
  return [
    DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(deliveryId, {
      state: 'pending',
      phase: delivery.phase,
      target_turn_id: writebackTarget ? null : delivery.target_turn_id,
      attempt_seq: delivery.attempt_seq
    }),
    ...authoritySteps,
    DOMAIN_REPOSITORIES.domain('Turn').assert(targetTurnId, { status: ACTIVE_TURN }),
    DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: targetTurnId }),
    DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assertNone({ turn_id: targetTurnId }),
    DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
      id: inputId,
      turn_id: targetTurnId,
      input_kind: 'runtime_delivery',
      content_object_id: contentObjectId,
      state: 'pending',
      created_at: now,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').insert({
      id: linkId,
      delivery_id: deliveryId,
      pending_turn_input_id: inputId,
      handled_at: null,
      created_at: now,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(deliveryId, {
      ...(writebackTarget ? { target_turn_id: targetTurnId } : {}),
      state: 'consumed',
      failure_reason: null,
      updated_at: now
    })
  ];
}

function requireDeliveryPhase(value: unknown): RuntimeDeliveryPhase {
  if (!DELIVERY_PHASES.has(value as RuntimeDeliveryPhase)) {
    throw new TypeError(`Unsupported RuntimeDelivery phase: ${String(value)}.`);
  }
  return value as RuntimeDeliveryPhase;
}

function requireDeliveryState(value: unknown): RuntimeDeliveryState {
  if (!DELIVERY_STATES.has(value as RuntimeDeliveryState)) {
    throw new TypeError(`Unsupported RuntimeDelivery state: ${String(value)}.`);
  }
  return value as RuntimeDeliveryState;
}

function isExpectedAnswerIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'answer_submission.id',
    'answer_submission.answer_bridge_id, answer_submission.submission_seq',
    'answer_payload.submission_id',
    'runtime_inbox_item.dedupe_key',
    'runtime_inbox_payload_link.inbox_item_id'
  ]);
}

function isExpectedForegroundRace(error: unknown): boolean {
  return isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
    'tool_result_artifact.id',
    'tool_result_artifact.tool_call_id, tool_result_artifact.role',
    'tool_outcome.tool_call_id',
    'tool_model_result.tool_call_id',
    'tool_model_result.message_revision_id'
  ]);
}

function isExpectedDeliveryIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'runtime_delivery.id',
    'runtime_delivery.inbox_item_id, runtime_delivery.target_conversation_id, runtime_delivery.attempt_seq'
  ]);
}

function isExpectedDeliveryInjectionRace(error: unknown): boolean {
  return isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
    'runtime_delivery_input_link.delivery_id',
    'runtime_delivery_input_link.pending_turn_input_id',
    'pending_turn_input.id'
  ]);
}

function extractVisibleAssistantText(raw: string, contentType: string): string {
  if (contentType !== 'application/vnd.limcode.message+json') return raw.trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return '';
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return '';
  const parts = (decoded as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object' && !Array.isArray(part))
    .filter((part) => part.thought !== true && typeof part.text === 'string')
    .map((part) => String(part.text).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function requireVisibleAssistantTextForProjection(raw: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new TypeError('Answer Runtime Delivery MessageContent must be valid JSON.');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError('Answer Runtime Delivery MessageContent must be an object.');
  }
  const parts = (decoded as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) {
    throw new TypeError('Answer Runtime Delivery MessageContent must contain parts.');
  }
  return parts
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object' && !Array.isArray(part))
    .filter((part) => part.thought !== true && typeof part.text === 'string')
    .map((part) => String(part.text).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function compareCounter(left: unknown, right: unknown): number {
  const a = typeof left === 'bigint' ? left : BigInt(String(left));
  const b = typeof right === 'bigint' ? right : BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireRows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} did not return rows.`);
  return value as DomainRow[];
}

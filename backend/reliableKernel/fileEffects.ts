import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  EffectControlPlane,
  effectIds,
  preparedContentSteps,
  stablePhaseDId,
  type EffectObservedOutcome,
  type PhaseDCommandSource,
  type PreparedEffectIntent,
  type ToolOutcomeStatus,
  type ToolTerminalResult
} from './effectControlPlane';
import { ContentAddressedStore, type ContentObjectMetadata, type PreparedContentObject } from './contentAddressedStore';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { canonicalPlainJson as canonicalJson } from './plainJson';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import { handoffReason, isExecutionHandoffError } from './executionLeaseFence';
import { isCanonicalPathInside } from '../capabilities/filesystem/pathContainment';
import { realPath } from '../capabilities/filesystem/realPath';

export type FileChangeOperation =
  | 'create_file'
  | 'replace_file'
  | 'delete_file'
  | 'create_directory'
  | 'delete_directory_tree';
export type FileChangeDecisionValue = 'approved' | 'rejected' | 'cancelled' | 'expired';
export type FileMemberOutcome = 'succeeded' | 'failed' | 'conflict' | 'cancelled' | 'outcome_unknown';
export type FileMutationOutcome = 'succeeded' | 'failed' | 'partial' | 'conflict' | 'cancelled' | 'outcome_unknown';

export interface FileChangeProposalMemberInput {
  operation: FileChangeOperation;
  workEnvironmentId: string;
  targetPath: string;
  baseDigest?: string | null;
  /** Exact pre-mutation bytes for replace/delete. Persisted in CAS so a completed Diff can reopen. */
  baseContent?: string | Uint8Array;
  baseContentType?: string;
  targetContent?: string | Uint8Array;
  contentType?: string;
}

export interface FileChangeProposalResult {
  receiptId: string;
  changeSetId: string;
  interactionRequestId: string;
  memberIds: string[];
  deduplicated: boolean;
  commitSeq?: string;
}

export interface FileChangeDecisionResult {
  receiptId: string;
  changeSetId: string;
  decision: FileChangeDecisionValue;
  won: boolean;
  deduplicated: boolean;
  preparedEffect?: PreparedEffectIntent;
  terminal?: ToolTerminalResult;
  commitSeq?: string;
}

export interface FileChangeDiffMemberSnapshot {
  memberId: string;
  changeSetId: string;
  toolCallId: string;
  memberSeq: string;
  operation: FileChangeOperation;
  workEnvironmentId: string;
  targetPath: string;
  baseContent: Buffer | null;
  targetContent: Buffer | null;
}

export interface FileMutationMemberObservation {
  memberId: string;
  memberSeq: string;
  outcome: FileMemberOutcome;
  actualDigest: string | null;
  error?: string;
}

export interface FileMutationObservation {
  changeSetId: string;
  outcome: FileMutationOutcome;
  members: FileMutationMemberObservation[];
}

export interface WorkEnvironmentBoundary {
  id: string;
  rootPath: string;
}

export type WorkEnvironmentBoundaryResolver = (
  workEnvironmentId: string
) => Promise<WorkEnvironmentBoundary | undefined> | WorkEnvironmentBoundary | undefined;

interface SourceCommit {
  receipt: DomainRow;
  deduplicated: boolean;
  firstResponseLost?: boolean;
  commitSeq?: string;
}

interface StoredMember {
  id: string;
  memberSeq: bigint;
  operation: FileChangeOperation;
  workEnvironmentId: string;
  targetPath: string;
  baseDigest: string | null;
  baseContentObjectId: string | null;
  targetContentObjectId: string | null;
  targetDigest: string | null;
}

interface FileEffectRequest {
  changeSetId: string;
  members: Array<{
    memberId: string;
    memberSeq: string;
    operation: FileChangeOperation;
    workEnvironmentId: string;
    targetPath: string;
    baseDigest: string | null;
    baseContentObjectId: string | null;
    targetContentObjectId: string | null;
    targetDigest: string | null;
  }>;
}

const FILE_EFFECT_KIND = 'file_mutation' as const;
const DIRECTORY_DIGEST = 'directory';
const ACTIVE_TURN = 'active';

class FilePathConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FilePathConflictError';
  }
}

/** File proposal/approval facts. Actual filesystem work is isolated in FileMutationDispatcher. */
export class FileChangeControlPlane {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly effects: EffectControlPlane,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async propose(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    members: FileChangeProposalMemberInput[];
  }): Promise<FileChangeProposalResult> {
    const source = normalizeSource(input.source, ['internal'], 'file-proposal');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    if (!Array.isArray(input.members) || input.members.length === 0) {
      throw new TypeError('FileChangeSet requires at least one member.');
    }
    const changeSetId = stablePhaseDId('file_change_set', toolCallId);
    const interactionRequestId = stablePhaseDId('interaction_request', `file-change:${changeSetId}`);
    const scope = JSON.stringify([toolCallId, changeSetId]);
    const receiptId = sourceReceiptId(source, 'file-proposal', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayProposal(duplicate, receiptId, changeSetId, interactionRequestId);
    const existing = await this.list('FileChangeSet', { tool_call_id: toolCallId }, 2);
    if (existing.length > 0) throw new Error(`ToolCall ${toolCallId} already has a FileChangeSet.`);

    const facts = await this.requireActiveToolFacts(toolCallId);
    if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
      throw new Error(`ToolCall ${toolCallId} cannot create a FileChangeSet from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
    }
    const now = this.timestamp();
    const preparedMembers: Array<{
      row: DomainRow;
      baseContent?: PreparedContentObject;
      targetContent?: PreparedContentObject;
    }> = [];
    for (let index = 0; index < input.members.length; index += 1) {
      const member = normalizeProposalMember(input.members[index]);
      const memberId = stablePhaseDId('file_change_set_member', `${changeSetId}:${index + 1}`);
      const baseContent = member.baseContent === undefined
        ? undefined
        : await this.contentStore.prepare(
            this.database,
            member.baseContent,
            member.baseContentType ?? 'application/octet-stream'
          );
      if (baseContent && baseContent.metadata.sha256 !== member.baseDigest) {
        throw new Error('baseContent digest does not match FileChangeSetMember.baseDigest.');
      }
      const targetContent = member.targetContent === undefined
        ? undefined
        : await this.contentStore.prepare(
            this.database,
            member.targetContent,
            member.contentType ?? 'application/octet-stream'
          );
      const targetDigest = targetContent?.metadata.sha256 ?? targetDigestWithoutContent(member.operation);
      preparedMembers.push({
        row: {
          id: memberId,
          change_set_id: changeSetId,
          member_seq: String(index + 1),
          operation: member.operation,
          work_environment_id: member.workEnvironmentId,
          target_path: member.targetPath,
          base_digest: member.baseDigest,
          base_content_object_id: baseContent?.metadata.id ?? null,
          target_content_object_id: targetContent?.metadata.id ?? null,
          target_digest: targetDigest,
          created_at: now
        },
        ...(baseContent ? { baseContent } : {}),
        ...(targetContent ? { targetContent } : {})
      });
    }
    const proposalBody = await this.contentStore.prepare(
      this.database,
      canonicalJson({
        changeSetId,
        toolCallId,
        members: preparedMembers.map(({ row }) => ({
          memberId: row.id,
          memberSeq: String(row.member_seq),
          operation: row.operation,
          workEnvironmentId: row.work_environment_id,
          targetPath: row.target_path,
          baseDigest: row.base_digest,
          baseContentObjectId: row.base_content_object_id,
          targetContentObjectId: row.target_content_object_id,
          targetDigest: row.target_digest
        }))
      }),
      'application/vnd.limcode.file-change-proposal+json'
    );
    const allContent = [
      proposalBody,
      ...preparedMembers.flatMap((entry) => [entry.baseContent, entry.targetContent]
        .filter((content): content is PreparedContentObject => content !== undefined))
    ];
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...preparedContentSteps(allContent, 'file_proposal'),
        DOMAIN_REPOSITORIES.domain('FileChangeSet').insert({
          id: changeSetId,
          tool_call_id: toolCallId,
          status: 'pending',
          created_at: now,
          updated_at: now
        }),
        ...preparedMembers.map((entry) => DOMAIN_REPOSITORIES.domain('FileChangeSetMember').insert(entry.row)),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').insert({
          id: interactionRequestId,
          request_kind: 'file_change_approval',
          status: 'pending',
          prompt_object_id: proposalBody.metadata.id,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionOwnerLink').insert({
          id: stablePhaseDId('interaction_owner_link', interactionRequestId),
          request_id: interactionRequestId,
          turn_id: facts.turn.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionToolCallLink').insert({
          id: stablePhaseDId('interaction_tool_call_link', interactionRequestId),
          request_id: interactionRequestId,
          tool_call_id: toolCallId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, {
          status: 'waiting_approval',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'waiting_approval',
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) return this.replayProposal(committed.receipt, receiptId, changeSetId, interactionRequestId);
    return {
      receiptId,
      changeSetId,
      interactionRequestId,
      memberIds: preparedMembers.map((entry) => entry.row.id as string),
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  public async decide(input: {
    source: PhaseDCommandSource;
    changeSetId: string;
    decision: FileChangeDecisionValue;
    response?: unknown;
  }): Promise<FileChangeDecisionResult> {
    const decision = requireDecision(input.decision);
    const allowed = decision === 'expired' ? ['command', 'recovery'] as const : ['command'] as const;
    const source = normalizeSource(input.source, allowed, 'file-decision');
    if (source.kind === 'recovery' && decision !== 'expired') {
      throw new TypeError('Recovery may only expire an unresolved FileChangeSet.');
    }
    const changeSetId = requireId(input.changeSetId, 'changeSetId');
    const changeSet = await this.requireExisting('FileChangeSet', changeSetId);
    const toolCallId = requireId(changeSet.tool_call_id, 'FileChangeSet.tool_call_id');
    const interactionRequestId = stablePhaseDId('interaction_request', `file-change:${changeSetId}`);
    const receiptId = sourceReceiptId(source, 'file-decision', JSON.stringify([changeSetId, decision]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayDecision(duplicate, receiptId, changeSetId, true);
    const existing = (await this.list('FileChangeDecision', { change_set_id: changeSetId }, 2))[0];
    if (existing) {
      const facts = await this.requireToolFacts(toolCallId);
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        steps: []
      });
      return this.decisionResultFromExisting(committed.receipt, existing, changeSetId, committed.deduplicated);
    }

    const facts = await this.requireActiveToolFacts(toolCallId);
    if (facts.toolCall.status !== 'waiting_approval' || facts.execution.status !== 'waiting_approval') {
      throw new Error(`ToolCall ${toolCallId} cannot decide a FileChangeSet from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
    }
    const responseContent = await this.contentStore.prepare(
      this.database,
      canonicalJson({
        changeSetId,
        decision,
        sourceReceiptId: receiptId,
        response: input.response ?? null
      }),
      'application/vnd.limcode.file-change-decision+json'
    );
    const now = this.timestamp();
    const commonSteps: RepositoryTransactionStep[] = [
      ...preparedContentSteps([responseContent], 'file_decision'),
      // The first-response UNIQUE linearizes before lifecycle assertions so a concurrent loser
      // can replay the committed decision rather than surfacing a stale-state assertion.
      DOMAIN_REPOSITORIES.domain('InteractionResponse').insert({
        id: stablePhaseDId('interaction_response', interactionRequestId),
        request_id: interactionRequestId,
        content_object_id: responseContent.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
        conversation_id: facts.conversation.id,
        turn_id: facts.turn.id
      }),
      DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'waiting_approval' }),
      DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'waiting_approval' }),
      DOMAIN_REPOSITORIES.domain('FileChangeSet').assert(changeSetId, { status: 'pending' }),
      DOMAIN_REPOSITORIES.domain('InteractionRequest').update(interactionRequestId, {
        status: decision,
        updated_at: now
      }),
      // Same key as the InteractionRequest is the frozen association; no hidden nullable owner field.
      DOMAIN_REPOSITORIES.domain('FileChangeDecision').insert({
        id: interactionRequestId,
        change_set_id: changeSetId,
        decision,
        decided_at: now
      }),
      DOMAIN_REPOSITORIES.domain('FileChangeSet').update(changeSetId, {
        status: decision,
        updated_at: now
      })
    ];

    if (decision === 'approved') {
      const members = await this.readStoredMembers(changeSetId);
      const request: FileEffectRequest = {
        changeSetId,
        members: members.map((member) => ({
          memberId: member.id,
          memberSeq: member.memberSeq.toString(),
          operation: member.operation,
          workEnvironmentId: member.workEnvironmentId,
          targetPath: member.targetPath,
          baseDigest: member.baseDigest,
          baseContentObjectId: member.baseContentObjectId,
          targetContentObjectId: member.targetContentObjectId,
          targetDigest: member.targetDigest
        }))
      };
      const requestContent = await this.contentStore.prepare(
        this.database,
        canonicalJson(request),
        'application/vnd.limcode.effect-file_mutation+json'
      );
      const ids = effectIds(toolCallId, 'file_change_set', changeSetId, FILE_EFFECT_KIND);
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        firstResponseChangeSetId: changeSetId,
        steps: [
          ...commonSteps,
          ...preparedContentSteps([requestContent], 'file_effect_request'),
          DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
            id: ids.operationId,
            owner_kind: 'file_change_set',
            owner_id: changeSetId,
            tool_call_id: toolCallId,
            status: 'pending',
            created_at: now,
            updated_at: now
          }, {
            column: 'operation_seq',
            scope: { owner_kind: 'file_change_set', owner_id: changeSetId }
          }),
          DOMAIN_REPOSITORIES.domain('Attempt').insert({
            id: ids.attemptId,
            operation_id: ids.operationId,
            attempt_seq: '1',
            status: 'pending',
            created_at: now,
            updated_at: now,
            completed_at: null
          }),
          DOMAIN_REPOSITORIES.domain('EffectIntent').insert({
            id: ids.effectIntentId,
            attempt_id: ids.attemptId,
            effect_kind: FILE_EFFECT_KIND,
            dispatch_state: 'pending',
            request_object_id: requestContent.metadata.id,
            created_at: now,
            updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'executing', updated_at: now }),
          DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
            status: 'executing',
            updated_at: now
          })
        ]
      });
      if (committed.deduplicated) return this.replayDecision(committed.receipt, receiptId, changeSetId, true);
      if (committed.firstResponseLost) {
        const winner = (await this.list('FileChangeDecision', { change_set_id: changeSetId }, 2))[0];
        if (!winner) throw new Error('FileChangeDecision race lost without a committed winner.');
        return this.decisionResultFromExisting(committed.receipt, winner, changeSetId, false);
      }
      return {
        receiptId,
        changeSetId,
        decision,
        won: true,
        deduplicated: false,
        commitSeq: committed.commitSeq,
        preparedEffect: {
          receiptId,
          toolCallId,
          toolExecutionId: facts.execution.id as string,
          ...ids,
          effectKind: FILE_EFFECT_KIND,
          deduplicated: false,
          commitSeq: committed.commitSeq
        }
      };
    }

    if (source.kind === 'recovery') {
      const terminalStatus: ToolOutcomeStatus = 'cancelled';
      const terminalPlan = await this.effects.prepareTerminalPlan(
        toolCallId,
        terminalStatus,
        { changeSetId, decision },
        receiptId
      );
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        firstResponseChangeSetId: changeSetId,
        steps: [...commonSteps, ...terminalPlan.steps]
      });
      if (committed.deduplicated) return this.replayDecision(committed.receipt, receiptId, changeSetId, true);
      if (committed.firstResponseLost) {
        const winner = (await this.list('FileChangeDecision', { change_set_id: changeSetId }, 2))[0];
        if (!winner) throw new Error('FileChangeDecision race lost without a committed winner.');
        return this.decisionResultFromExisting(committed.receipt, winner, changeSetId, false);
      }
      return {
        receiptId,
        changeSetId,
        decision,
        won: true,
        deduplicated: false,
        commitSeq: committed.commitSeq,
        terminal: {
          ...withoutTerminalSteps(terminalPlan),
          receiptId,
          deduplicated: false,
          commitSeq: committed.commitSeq
        }
      };
    }

    // The first user response is authoritative even when an earlier call_seq delays model-result
    // assembly. Persist the decision first, then let the ordered finalizer advance what is ready.
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      firstResponseChangeSetId: changeSetId,
      steps: commonSteps
    });
    if (committed.deduplicated) return this.replayDecision(committed.receipt, receiptId, changeSetId, true);
    if (committed.firstResponseLost) {
      const winner = (await this.list('FileChangeDecision', { change_set_id: changeSetId }, 2))[0];
      if (!winner) throw new Error('FileChangeDecision race lost without a committed winner.');
      return this.decisionResultFromExisting(committed.receipt, winner, changeSetId, false);
    }
    const finalized = await this.effects.finalizeReadyInOrder(facts.turn.id as string);
    const terminal = finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.effects.readTerminalResult(toolCallId, false);
    return {
      receiptId,
      changeSetId,
      decision,
      won: true,
      deduplicated: false,
      commitSeq: committed.commitSeq,
      ...(terminal ? { terminal: { ...terminal, receiptId } } : {})
    };
  }

  /** Reads immutable proposal bytes for inline/VS Code Diff. Workspace state is intentionally ignored. */
  public async readDiffMember(memberIdInput: string): Promise<FileChangeDiffMemberSnapshot> {
    const memberId = requireId(memberIdInput, 'memberId');
    const row = await this.requireExisting('FileChangeSetMember', memberId);
    const stored = this.storedMemberFromRow(row);
    await this.assertStoredMemberContent(stored);
    const changeSetId = requireId(row.change_set_id, 'FileChangeSetMember.change_set_id');
    const changeSet = await this.requireExisting('FileChangeSet', changeSetId);
    return this.materializeDiffMember(stored, changeSetId, requireId(changeSet.tool_call_id, 'FileChangeSet.tool_call_id'));
  }

  public async readToolDiffMembers(toolCallIdInput: string): Promise<FileChangeDiffMemberSnapshot[]> {
    const toolCallId = requireId(toolCallIdInput, 'toolCallId');
    const changeSets = await this.list('FileChangeSet', { tool_call_id: toolCallId }, 2);
    if (changeSets.length !== 1) throw new Error(`ToolCall ${toolCallId} must have one FileChangeSet to open Diff.`);
    const changeSetId = requireId(changeSets[0].id, 'FileChangeSet.id');
    const members = await this.readStoredMembers(changeSetId);
    return Promise.all(members.map((member) => this.materializeDiffMember(member, changeSetId, toolCallId)));
  }

  /** Builds only the unresolved-file facts that must share the Turn terminal transaction. */
  public async prepareUnresolvedTurnClosure(
    turnIdInput: string,
    options: { requireLease?: boolean } = {}
  ): Promise<RepositoryTransactionStep[]> {
    const turnId = requireId(turnIdInput, 'turnId');
    const requireLease = options.requireLease !== false;
    const pending = await listAllDomainRows(this.database, 'FileChangeSet', { status: 'pending' });
    const candidates: Array<{ changeSet: DomainRow; toolCall: DomainRow }> = [];
    for (const changeSet of pending) {
      const toolCall = await this.requireExisting(
        'ToolCall',
        requireId(changeSet.tool_call_id, 'FileChangeSet.tool_call_id')
      );
      if (toolCall.turn_id === turnId) candidates.push({ changeSet, toolCall });
    }
    candidates.sort((left, right) => compareBigInts(
      requireBigInt(left.toolCall.call_seq, 'ToolCall.call_seq'),
      requireBigInt(right.toolCall.call_seq, 'ToolCall.call_seq')
    ));
    const planned = new Set<string>();
    const steps: RepositoryTransactionStep[] = [];
    for (const { changeSet, toolCall } of candidates) {
      const changeSetId = requireId(changeSet.id, 'FileChangeSet.id');
      const toolCallId = requireId(toolCall.id, 'ToolCall.id');
      const facts = requireLease
        ? await this.requireActiveToolFacts(toolCallId)
        : await this.requireToolFacts(toolCallId);
      const requestId = stablePhaseDId('interaction_request', `file-change:${changeSetId}`);
      const source: PhaseDCommandSource = {
        kind: 'internal',
        key: `turn-terminal-file:${turnId}:${changeSetId}`
      };
      const receiptId = sourceReceiptId(source, 'file-decision', JSON.stringify([changeSetId, 'expired']));
      const responseContent = await this.contentStore.prepare(
        this.database,
        canonicalJson({
          changeSetId,
          decision: 'expired',
          sourceReceiptId: receiptId,
          response: { reason: 'turn-terminal' }
        }),
        'application/vnd.limcode.file-change-decision+json'
      );
      const terminalPlan = await this.effects.prepareTerminalPlan(
        toolCallId,
        'cancelled',
        { changeSetId, decision: 'expired', reason: 'turn-terminal' },
        receiptId,
        planned,
        { requireLease }
      );
      const now = this.timestamp();
      steps.push(
        ...preparedContentSteps([responseContent], 'file_turn_terminal'),
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: receiptId,
          source_kind: source.kind,
          source_key: source.key,
          conversation_id: facts.conversation.id,
          turn_id: turnId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionResponse').insert({
          id: stablePhaseDId('interaction_response', requestId),
          request_id: requestId,
          content_object_id: responseContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').update(requestId, {
          status: 'expired',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('FileChangeDecision').insert({
          id: requestId,
          change_set_id: changeSetId,
          decision: 'expired',
          decided_at: now
        }),
        DOMAIN_REPOSITORIES.domain('FileChangeSet').update(changeSetId, {
          status: 'expired',
          updated_at: now
        }),
        ...terminalPlan.steps
      );
      planned.add(toolCallId);
    }
    return steps;
  }

  public async reconcileEffectReceipt(effectReceiptIdInput: string): Promise<ToolTerminalResult | null> {
    const effectReceiptId = requireId(effectReceiptIdInput, 'effectReceiptId');
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    if (receipt.effect_kind !== FILE_EFFECT_KIND) throw new Error('EffectReceipt is not a file_mutation receipt.');
    const attempt = await this.requireExisting('Attempt', requireId(receipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    if (operation.owner_kind !== 'file_change_set') throw new Error('file_mutation Operation must belong to FileChangeSet.');
    const changeSetId = requireId(operation.owner_id, 'Operation.owner_id');
    const existing = (await this.list('FileMutationReceipt', { effect_receipt_id: effectReceiptId }, 2))[0];
    const source: PhaseDCommandSource = { kind: 'internal', key: `file-reconcile:${effectReceiptId}` };
    if (existing) {
      return this.effects.completeOperation({
        source,
        effectReceiptId,
        outcome: fileOutcomeToToolOutcome(requireFileMutationOutcome(existing.outcome))
      });
    }
    const observation = await this.readObservation(receipt, changeSetId);
    const domainReceiptId = stablePhaseDId('file_mutation_receipt', effectReceiptId);
    const now = this.timestamp();
    const additionalSteps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('FileMutationReceipt').insert({
        id: domainReceiptId,
        effect_receipt_id: effectReceiptId,
        change_set_id: changeSetId,
        outcome: observation.outcome,
        created_at: now
      }),
      ...observation.members.map((member) => DOMAIN_REPOSITORIES.domain('FileMutationReceiptMember').insert({
        id: stablePhaseDId('file_mutation_receipt_member', `${domainReceiptId}:${member.memberId}`),
        receipt_id: domainReceiptId,
        member_id: member.memberId,
        outcome: member.outcome,
        actual_digest: member.actualDigest,
        created_at: now
      })),
      DOMAIN_REPOSITORIES.domain('FileChangeSet').update(changeSetId, {
        status: observation.outcome,
        updated_at: now
      })
    ];
    return this.effects.completeOperation({
      source,
      effectReceiptId,
      outcome: fileOutcomeToToolOutcome(observation.outcome),
      additionalSteps
    });
  }

  public async recoverDispatchedEffect(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
    resolver: WorkEnvironmentBoundaryResolver;
  }): Promise<ToolTerminalResult | null> {
    const source = normalizeSource(input.source, ['recovery'], 'file-effect-recovery');
    const intent = await this.requireExisting('EffectIntent', requireId(input.effectIntentId, 'effectIntentId'));
    if (intent.effect_kind !== FILE_EFFECT_KIND) throw new Error('Recovery target is not file_mutation.');
    if (intent.dispatch_state !== 'dispatched') throw new Error('Only dispatched file EffectIntent is recoverable.');
    const existingReceipts = await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2);
    if (existingReceipts.length > 0) return this.reconcileEffectReceipt(existingReceipts[0].id as string);
    const request = await this.effects.readEffectRequest<FileEffectRequest>(intent.id as string);
    const dispatcher = new FileMutationDispatcher(this.database, this.contentStore, this.effects, input.resolver);
    const observation = await dispatcher.inspect(request);
    const recorded = await this.effects.recordEffectReceipt({
      source,
      attemptId: intent.attempt_id as string,
      effectKind: FILE_EFFECT_KIND,
      outcome: fileObservationToEffectOutcome(observation.outcome),
      detail: observation
    });
    return this.reconcileEffectReceipt(recorded.effectReceiptId);
  }

  private async readObservation(receipt: DomainRow, changeSetId: string): Promise<FileMutationObservation> {
    const approved = await this.readStoredMembers(changeSetId);
    if (receipt.response_object_id === null) {
      return {
        changeSetId,
        outcome: 'outcome_unknown',
        members: approved.map((member) => ({
          memberId: member.id,
          memberSeq: member.memberSeq.toString(),
          outcome: 'outcome_unknown',
          actualDigest: null,
          error: 'EffectReceipt contains no member-level observation detail.'
        }))
      };
    }
    const metadata = await this.requireContentObject(requireId(receipt.response_object_id, 'EffectReceipt.response_object_id'));
    const parsed = JSON.parse((await this.contentStore.read(metadata)).toString('utf8'));
    const observation = normalizeObservation(parsed, changeSetId);
    if (observation.members.length === 0 || observation.members.length > approved.length) {
      throw new Error('FileMutation observation must contain an approved member prefix.');
    }
    observation.members.forEach((member, index) => {
      const expected = approved[index];
      if (member.memberId !== expected.id || member.memberSeq !== expected.memberSeq.toString()) {
        throw new Error('FileMutation observation member does not match the approved member order.');
      }
    });
    if (
      observation.members.length < approved.length
      && observation.members[observation.members.length - 1].outcome === 'succeeded'
    ) throw new Error('FileMutation observation stopped after a successful member without a terminal member fact.');
    return observation;
  }

  private async replayProposal(
    receipt: DomainRow,
    expectedReceiptId: string,
    changeSetId: string,
    interactionRequestId: string
  ): Promise<FileChangeProposalResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'file-proposal');
    await this.requireExisting('FileChangeSet', changeSetId);
    await this.requireExisting('InteractionRequest', interactionRequestId);
    const members = await this.readStoredMembers(changeSetId);
    return {
      receiptId: receipt.id as string,
      changeSetId,
      interactionRequestId,
      memberIds: members.map((member) => member.id),
      deduplicated: true
    };
  }

  private async replayDecision(
    receipt: DomainRow,
    expectedReceiptId: string,
    changeSetId: string,
    deduplicated: boolean
  ): Promise<FileChangeDecisionResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'file-decision');
    const decision = (await this.list('FileChangeDecision', { change_set_id: changeSetId }, 2))[0];
    if (!decision) throw new Error('Stable file decision source has no FileChangeDecision.');
    const changeSet = await this.requireExisting('FileChangeSet', changeSetId);
    const toolCall = await this.requireExisting('ToolCall', requireId(changeSet.tool_call_id, 'FileChangeSet.tool_call_id'));
    await this.effects.finalizeReadyInOrder(requireId(toolCall.turn_id, 'ToolCall.turn_id'));
    return this.decisionResultFromExisting(receipt, decision, changeSetId, deduplicated);
  }

  private async decisionResultFromExisting(
    receipt: DomainRow,
    decision: DomainRow,
    changeSetId: string,
    deduplicated: boolean
  ): Promise<FileChangeDecisionResult> {
    const value = requireDecision(decision.decision);
    const won = await this.decisionReceiptWon(changeSetId, receipt.id as string);
    const changeSet = await this.requireExisting('FileChangeSet', changeSetId);
    const toolCallId = requireId(changeSet.tool_call_id, 'FileChangeSet.tool_call_id');
    if (value === 'approved') {
      const ids = effectIds(toolCallId, 'file_change_set', changeSetId, FILE_EFFECT_KIND);
      await this.requireExisting('EffectIntent', ids.effectIntentId);
      const executions = await this.list('ToolExecution', { tool_call_id: toolCallId }, 2);
      return {
        receiptId: receipt.id as string,
        changeSetId,
        decision: value,
        won,
        deduplicated,
        preparedEffect: {
          receiptId: receipt.id as string,
          toolCallId,
          toolExecutionId: executions[0]?.id as string,
          ...ids,
          effectKind: FILE_EFFECT_KIND,
          deduplicated: true,
        }
      };
    }
    const terminal = await this.effects.readTerminalResult(toolCallId, true, receipt.id as string);
    return {
      receiptId: receipt.id as string,
      changeSetId,
      decision: value,
      won,
      deduplicated,
      ...(terminal ? { terminal: { ...terminal, receiptId: receipt.id as string } } : {})
    };
  }

  private async requireActiveToolFacts(toolCallId: string): Promise<{
    toolCall: DomainRow;
    execution: DomainRow;
    turn: DomainRow;
    conversation: DomainRow;
    lease: DomainRow;
  }> {
    const facts = await this.requireToolFacts(toolCallId);
    const leases = await this.list('ExecutionLease', { turn_id: facts.turn.id }, 2);
    if (facts.turn.status !== ACTIVE_TURN || leases.length !== 1) {
      throw new Error(`ToolCall ${toolCallId} requires its active Turn ExecutionLease.`);
    }
    return { ...facts, lease: leases[0] };
  }

  private async requireToolFacts(toolCallId: string): Promise<{
    toolCall: DomainRow;
    execution: DomainRow;
    turn: DomainRow;
    conversation: DomainRow;
  }> {
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const executions = await this.list('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executions.length !== 1) throw new Error(`ToolCall ${toolCallId} must have one ToolExecution.`);
    const turn = await this.requireExisting('Turn', requireId(toolCall.turn_id, 'ToolCall.turn_id'));
    const conversation = await this.requireExisting('Conversation', requireId(turn.conversation_id, 'Turn.conversation_id'));
    return { toolCall, execution: executions[0], turn, conversation };
  }

  private async readStoredMembers(changeSetId: string): Promise<StoredMember[]> {
    const requestId = stablePhaseDId('interaction_request', `file-change:${changeSetId}`);
    const request = await this.requireExisting('InteractionRequest', requestId);
    const metadata = await this.requireContentObject(requireId(request.prompt_object_id, 'InteractionRequest.prompt_object_id'));
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as {
      changeSetId?: unknown;
      members?: unknown;
    };
    if (body.changeSetId !== changeSetId || !Array.isArray(body.members) || body.members.length === 0) {
      throw new Error('File proposal CAS body does not match its FileChangeSet.');
    }
    const rows = await Promise.all(body.members.map(async (entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('Invalid file proposal member reference.');
      }
      const reference = entry as Record<string, unknown>;
      const memberId = requireId(reference.memberId, 'proposal.memberId');
      const row = await this.requireExisting('FileChangeSetMember', memberId);
      if (
        row.change_set_id !== changeSetId
        || requireBigInt(row.member_seq, 'FileChangeSetMember.member_seq') !== BigInt(index + 1)
      ) throw new Error('File proposal member reference does not match SQLite facts.');
      return row;
    }));
    return Promise.all(rows.map(async (row) => {
      const member = this.storedMemberFromRow(row);
      await this.assertStoredMemberContent(member);
      return member;
    }));
  }

  private storedMemberFromRow(row: DomainRow): StoredMember {
    return {
      id: requireId(row.id, 'FileChangeSetMember.id'),
      memberSeq: requireBigInt(row.member_seq, 'FileChangeSetMember.member_seq'),
      operation: requireOperation(row.operation),
      workEnvironmentId: requireId(row.work_environment_id, 'FileChangeSetMember.work_environment_id'),
      targetPath: requireText(row.target_path, 'FileChangeSetMember.target_path'),
      baseDigest: nullableDigest(row.base_digest, 'FileChangeSetMember.base_digest'),
      baseContentObjectId: nullableId(row.base_content_object_id, 'FileChangeSetMember.base_content_object_id'),
      targetContentObjectId: nullableId(row.target_content_object_id, 'FileChangeSetMember.target_content_object_id'),
      targetDigest: nullableTargetDigest(row.target_digest, 'FileChangeSetMember.target_digest')
    };
  }

  private async materializeDiffMember(
    member: StoredMember,
    changeSetId: string,
    toolCallId: string
  ): Promise<FileChangeDiffMemberSnapshot> {
    const read = async (contentObjectId: string | null): Promise<Buffer | null> => {
      if (!contentObjectId) return null;
      return this.contentStore.read(await this.requireContentObject(contentObjectId));
    };
    return {
      memberId: member.id,
      changeSetId,
      toolCallId,
      memberSeq: member.memberSeq.toString(),
      operation: member.operation,
      workEnvironmentId: member.workEnvironmentId,
      targetPath: member.targetPath,
      baseContent: await read(member.baseContentObjectId),
      targetContent: await read(member.targetContentObjectId)
    };
  }

  private async assertStoredMemberContent(member: StoredMember): Promise<void> {
    const requiresFileBase = member.operation === 'replace_file' || member.operation === 'delete_file';
    if (requiresFileBase !== (member.baseContentObjectId !== null)) {
      throw new Error(`${member.operation} has an invalid base ContentObject reference.`);
    }
    if (member.baseContentObjectId) {
      const metadata = await this.requireContentObject(member.baseContentObjectId);
      if (metadata.sha256 !== member.baseDigest) {
        throw new Error('Base ContentObject digest does not match FileChangeSetMember.baseDigest.');
      }
    }
    const requiresTargetContent = member.operation === 'create_file' || member.operation === 'replace_file';
    if (requiresTargetContent !== (member.targetContentObjectId !== null)) {
      throw new Error(`${member.operation} has an invalid target ContentObject reference.`);
    }
    if (member.targetContentObjectId) {
      const metadata = await this.requireContentObject(member.targetContentObjectId);
      if (metadata.sha256 !== member.targetDigest) {
        throw new Error('Target ContentObject digest does not match FileChangeSetMember.targetDigest.');
      }
    }
  }

  private async decisionReceiptWon(changeSetId: string, receiptId: string): Promise<boolean> {
    const requestId = stablePhaseDId('interaction_request', `file-change:${changeSetId}`);
    const response = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (!response) throw new Error('FileChangeDecision has no InteractionResponse.');
    const metadata = await this.requireContentObject(
      requireId(response.content_object_id, 'InteractionResponse.content_object_id')
    );
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    return body.sourceReceiptId === receiptId;
  }

  private async commitSource(options: {
    source: PhaseDCommandSource;
    receiptId: string;
    conversationId: string;
    turnId: string;
    firstResponseChangeSetId?: string;
    steps: RepositoryTransactionStep[];
  }): Promise<SourceCommit> {
    const existing = await this.findSourceReceipt(options.source);
    if (existing) {
      assertSourceReceipt(existing, options.receiptId, 'file command');
      return { receipt: existing, deduplicated: true };
    }
    const receipt = {
      id: options.receiptId,
      source_kind: options.source.kind,
      source_key: options.source.key,
      conversation_id: options.conversationId,
      turn_id: options.turnId,
      created_at: this.timestamp()
    };
    try {
      const result = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert(receipt),
        ...options.steps
      ]);
      return { receipt, deduplicated: false, commitSeq: result.commitSeq };
    } catch (error) {
      if (!matchesExpectedUnique(error, [
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']],
        ['interaction_response', ['id']],
        ['interaction_response', ['request_id']],
        ['file_change_decision', ['id']],
        ['file_change_decision', ['change_set_id']]
      ])) throw error;
      const racedSource = await this.findSourceReceipt(options.source);
      if (racedSource) {
        assertSourceReceipt(racedSource, options.receiptId, 'file command');
        return { receipt: racedSource, deduplicated: true };
      }
      if (options.firstResponseChangeSetId) {
        const winner = (await this.list('FileChangeDecision', {
          change_set_id: options.firstResponseChangeSetId
        }, 2))[0];
        if (winner) {
          const receiptOnly = await this.commitSource({
            source: options.source,
            receiptId: options.receiptId,
            conversationId: options.conversationId,
            turnId: options.turnId,
            steps: []
          });
          return { ...receiptOnly, firstResponseLost: true };
        }
      }
      throw error;
    }
  }

  private async findSourceReceipt(source: PhaseDCommandSource): Promise<DomainRow | undefined> {
    return (await this.list('CommandReceipt', { source_kind: source.kind, source_key: source.key }, 2))[0];
  }

  private async requireContentObject(id: string): Promise<ContentObjectMetadata> {
    return await this.requireExisting('ContentObject', id) as ContentObjectMetadata;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

/** Dedicated file capability dispatcher; it has no ToolOutcome policy. */
export class FileMutationDispatcher {
  private readonly activeDispatches = new Set<string>();

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly effects: EffectControlPlane,
    private readonly resolveBoundary: WorkEnvironmentBoundaryResolver,
    private readonly onConvergenceNeeded?: () => void
  ) {}

  public async dispatch(
    effectIntentId: string,
    signal?: AbortSignal
  ): Promise<FileMutationObservation | null> {
    if (signal?.aborted) {
      const handoff = handoffReason(signal);
      if (handoff) throw handoff;
      const cancelled = await this.effects.cancelPendingEffect({
        source: { kind: 'internal', key: `file-mutation:${effectIntentId}:cancel-before-dispatch` },
        effectIntentId,
        detail: { reason: 'File mutation cancelled before capability dispatch.' }
      });
      if (cancelled) return null;
    }
    if (!await this.effects.claimEffectDispatch(effectIntentId)) return null;
    return this.executeDispatched(effectIntentId, signal);
  }

  /** Executes one already-dispatched intent and returns observation; caller persists the Receipt. */
  public async executeDispatched(
    effectIntentIdInput: string,
    signal?: AbortSignal
  ): Promise<FileMutationObservation> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    if (intent.effect_kind !== FILE_EFFECT_KIND || intent.dispatch_state !== 'dispatched') {
      throw new Error('File mutation requires a committed dispatched file_mutation EffectIntent.');
    }
    const receipts = await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 1);
    if (receipts.length > 0) throw new Error('File mutation EffectIntent already has a Receipt and cannot execute again.');
    const request = await this.effects.readEffectRequest<FileEffectRequest>(effectIntentId);
    return this.apply(request, signal);
  }

  public async dispatchRecordAndReconcile(effectIntentIdInput: string, signal?: AbortSignal): Promise<{
    observation: FileMutationObservation | null;
    terminal: ToolTerminalResult | null;
  }> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    const ownsActiveMarker = !this.activeDispatches.has(effectIntentId);
    if (ownsActiveMarker) this.activeDispatches.add(effectIntentId);
    try {
      return await this.dispatchRecordAndReconcileActive(effectIntentId, signal);
    } finally {
      if (ownsActiveMarker) this.activeDispatches.delete(effectIntentId);
    }
  }

  public isDispatchActive(effectIntentIdInput: string): boolean {
    return this.activeDispatches.has(requireId(effectIntentIdInput, 'effectIntentId'));
  }

  public async recoverDispatchedAndReconcile(effectIntentIdInput: string): Promise<ToolTerminalResult | null> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    if (this.activeDispatches.has(effectIntentId)) return null;
    this.activeDispatches.add(effectIntentId);
    try {
      const control = new FileChangeControlPlane(this.database, this.contentStore, this.effects);
      return await control.recoverDispatchedEffect({
        source: { kind: 'recovery', key: `file-mutation:${effectIntentId}:same-host-convergence` },
        effectIntentId,
        resolver: this.resolveBoundary
      });
    } finally {
      this.activeDispatches.delete(effectIntentId);
    }
  }

  private async dispatchRecordAndReconcileActive(effectIntentId: string, signal?: AbortSignal): Promise<{
    observation: FileMutationObservation | null;
    terminal: ToolTerminalResult | null;
  }> {
    let observation: FileMutationObservation | null;
    try {
      observation = await this.dispatch(effectIntentId, signal);
    } catch (error) {
      if (isExecutionHandoffError(error)) throw error;
      const intent = await this.requireExisting('EffectIntent', effectIntentId);
      if (intent.effect_kind !== FILE_EFFECT_KIND || intent.dispatch_state !== 'dispatched') throw error;
      const control = new FileChangeControlPlane(this.database, this.contentStore, this.effects);
      try {
        return {
          observation: null,
          terminal: await control.recoverDispatchedEffect({
            source: { kind: 'recovery', key: `file-mutation:${effectIntentId}:same-host-recovery` },
            effectIntentId,
            resolver: this.resolveBoundary
          })
        };
      } catch (recoveryError) {
        this.onConvergenceNeeded?.();
        throw recoveryError;
      }
    }
    if (!observation) {
      const intent = await this.requireExisting('EffectIntent', effectIntentId);
      const attempt = await this.requireExisting('Attempt', requireId(intent.attempt_id, 'EffectIntent.attempt_id'));
      const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
      const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
      const receipts = await this.list('EffectReceipt', { attempt_id: attempt.id }, 2);
      if (receipts.length > 1) throw new Error(`File mutation EffectIntent ${effectIntentId} has multiple receipts.`);
      if (receipts.length === 1) {
        const control = new FileChangeControlPlane(this.database, this.contentStore, this.effects);
        return {
          observation: null,
          terminal: await control.reconcileEffectReceipt(requireId(receipts[0].id, 'EffectReceipt.id'))
        };
      }
      return {
        observation: null,
        terminal: await this.effects.readTerminalResult(toolCallId, false)
      };
    }
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    const recorded = await this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `file-effect:${String(intent.attempt_id)}:receipt` },
      attemptId: intent.attempt_id as string,
      effectKind: FILE_EFFECT_KIND,
      outcome: fileObservationToEffectOutcome(observation.outcome),
      detail: observation
    });
    const control = new FileChangeControlPlane(this.database, this.contentStore, this.effects);
    return { observation, terminal: await control.reconcileEffectReceipt(recorded.effectReceiptId) };
  }

  public async inspect(requestInput: FileEffectRequest): Promise<FileMutationObservation> {
    const request = normalizeEffectRequest(requestInput);
    const members: FileMutationMemberObservation[] = [];
    for (const member of request.members) {
      const actual = await this.inspectActual(member);
      members.push(reconcileMemberObservation(member, actual));
    }
    return {
      changeSetId: request.changeSetId,
      outcome: aggregateFileMemberOutcomes(members),
      members
    };
  }

  private async apply(
    requestInput: FileEffectRequest,
    signal?: AbortSignal
  ): Promise<FileMutationObservation> {
    const request = normalizeEffectRequest(requestInput);
    const members: FileMutationMemberObservation[] = [];
    for (const member of request.members) {
      if (signal?.aborted) {
        members.push(memberObservation(
          member,
          'cancelled',
          null,
          'File mutation cancelled before this member was dispatched.'
        ));
        break;
      }
      const observation = await this.applyMember(member, signal);
      members.push(observation);
      if (observation.outcome !== 'succeeded') break;
    }
    return {
      changeSetId: request.changeSetId,
      outcome: aggregateFileMemberOutcomes(members),
      members
    };
  }

  private async applyMember(
    member: FileEffectRequest['members'][number],
    signal?: AbortSignal
  ): Promise<FileMutationMemberObservation> {
    let resolved: string;
    try {
      resolved = await resolveBoundedTarget(this.resolveBoundary, member.workEnvironmentId, member.targetPath);
    } catch (error) {
      return error instanceof FilePathConflictError
        ? memberObservation(member, 'conflict', null, error.message)
        : memberObservation(member, 'outcome_unknown', null, errorMessage(error));
    }
    const before = await inspectPath(resolved);
    if (before.kind === 'unknown') return memberObservation(member, 'outcome_unknown', null, before.error);
    if (before.symlink) return memberObservation(member, 'conflict', before.digest, 'Target path is a symbolic link.');
    const creates = member.operation === 'create_file' || member.operation === 'create_directory';
    if (creates ? before.digest !== null : !sameDigest(before.digest, member.baseDigest)) {
      return memberObservation(
        member,
        'conflict',
        before.digest,
        creates ? 'Create target already exists.' : 'baseDigest does not match the actual target.'
      );
    }
    if (signal?.aborted) {
      return memberObservation(member, 'cancelled', before.digest, 'File mutation cancelled before member dispatch.');
    }

    try {
      switch (member.operation) {
        case 'create_file': {
          const bytes = await this.readTargetBytes(member);
          if (signal?.aborted) {
            return memberObservation(member, 'cancelled', before.digest, 'File mutation cancelled before write dispatch.');
          }
          await fs.writeFile(resolved, bytes, { flag: 'wx' });
          break;
        }
        case 'replace_file': {
          const bytes = await this.readTargetBytes(member);
          if (signal?.aborted) {
            return memberObservation(member, 'cancelled', before.digest, 'File mutation cancelled before write dispatch.');
          }
          await fs.writeFile(resolved, bytes, { flag: 'w' });
          break;
        }
        case 'delete_file':
          await fs.unlink(resolved);
          break;
        case 'create_directory':
          await fs.mkdir(resolved);
          break;
        case 'delete_directory_tree':
          await fs.rm(resolved, { recursive: true, force: false });
          break;
      }
    } catch (error) {
      const afterFailure = await inspectPath(resolved);
      if (afterFailure.kind === 'unknown') {
        return memberObservation(member, 'outcome_unknown', null, `${errorMessage(error)}; ${afterFailure.error}`);
      }
      const reconciled = reconcileMemberObservation(member, afterFailure);
      if (reconciled.outcome === 'succeeded') return reconciled;
      if (member.operation === 'delete_directory_tree') {
        return memberObservation(
          member,
          'outcome_unknown',
          afterFailure.digest,
          `Recursive deletion failed after dispatch; partial mutation cannot be disproved: ${errorMessage(error)}`
        );
      }
      return { ...reconciled, error: errorMessage(error) };
    }
    return reconcileMemberObservation(member, await inspectPath(resolved));
  }

  private async readTargetBytes(member: FileEffectRequest['members'][number]): Promise<Buffer> {
    const id = nullableId(member.targetContentObjectId, 'targetContentObjectId');
    if (!id) throw new Error(`${member.operation} requires target content.`);
    const metadata = await this.requireExisting('ContentObject', id) as ContentObjectMetadata;
    const bytes = await this.contentStore.read(metadata);
    if (createHash('sha256').update(bytes).digest('hex') !== member.targetDigest) {
      throw new Error('Target ContentObject digest does not match FileChangeSetMember.targetDigest.');
    }
    return bytes;
  }

  private async inspectActual(member: FileEffectRequest['members'][number]): Promise<PathInspection> {
    try {
      const resolved = await resolveBoundedTarget(this.resolveBoundary, member.workEnvironmentId, member.targetPath);
      return inspectPath(resolved);
    } catch (error) {
      return error instanceof FilePathConflictError
        ? { kind: 'conflict', digest: null, symlink: false, error: error.message }
        : { kind: 'unknown', digest: null, symlink: false, error: errorMessage(error) };
    }
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }
}

type PathInspection =
  | { kind: 'known'; digest: string | null; symlink: boolean; error?: undefined }
  | { kind: 'conflict'; digest: null; symlink: false; error: string }
  | { kind: 'unknown'; digest: null; symlink: false; error: string };

async function resolveBoundedTarget(
  resolver: WorkEnvironmentBoundaryResolver,
  workEnvironmentId: string,
  targetPath: string
): Promise<string> {
  const boundary = await resolver(workEnvironmentId);
  if (!boundary || boundary.id !== workEnvironmentId) {
    throw new FilePathConflictError(`WorkEnvironment is not registered: ${workEnvironmentId}`);
  }
  const configuredRoot = path.resolve(requireText(boundary.rootPath, 'WorkEnvironment.rootPath'));
  const realRoot = await realPath(configuredRoot);
  const target = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(realRoot, targetPath);
  assertWithin(realRoot, target);
  const parent = path.dirname(target);
  let realParent: string;
  try {
    realParent = await realPath(parent);
  } catch (error) {
    if (isNotFound(error)) throw new FilePathConflictError('File target parent does not exist.');
    throw error;
  }
  assertWithin(realRoot, realParent);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new FilePathConflictError('Target path is a symbolic link.');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return target;
}

/** Both sides derive from realpath of the same root, so compare exactly (see isCanonicalPathInside). */
function assertWithin(root: string, candidate: string): void {
  if (!isCanonicalPathInside(root, candidate)) {
    throw new FilePathConflictError('File target escapes the registered WorkEnvironment boundary.');
  }
}

async function inspectPath(target: string): Promise<PathInspection> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return { kind: 'known', digest: 'symlink', symlink: true };
    if (stat.isDirectory()) return { kind: 'known', digest: DIRECTORY_DIGEST, symlink: false };
    if (!stat.isFile()) return { kind: 'known', digest: `other:${stat.mode}`, symlink: false };
    const bytes = await fs.readFile(target);
    return {
      kind: 'known',
      digest: createHash('sha256').update(bytes).digest('hex'),
      symlink: false
    };
  } catch (error) {
    if (isNotFound(error)) return { kind: 'known', digest: null, symlink: false };
    return { kind: 'unknown', digest: null, symlink: false, error: errorMessage(error) };
  }
}

function reconcileMemberObservation(
  member: FileEffectRequest['members'][number],
  actual: PathInspection
): FileMutationMemberObservation {
  if (actual.kind === 'unknown') return memberObservation(member, 'outcome_unknown', null, actual.error);
  if (actual.kind === 'conflict') return memberObservation(member, 'conflict', null, actual.error);
  if (actual.symlink) return memberObservation(member, 'conflict', actual.digest, 'Target path is a symbolic link.');
  if (sameDigest(actual.digest, member.targetDigest)) return memberObservation(member, 'succeeded', actual.digest);
  if (member.operation === 'delete_directory_tree' && actual.digest === DIRECTORY_DIGEST) {
    return memberObservation(
      member,
      'outcome_unknown',
      actual.digest,
      'Directory still exists after dispatch; a constant directory digest cannot disprove partial deletion.'
    );
  }
  if (sameDigest(actual.digest, member.baseDigest)) return memberObservation(member, 'failed', actual.digest, 'Mutation was not applied.');
  return memberObservation(member, 'conflict', actual.digest, 'Actual digest matches neither baseDigest nor targetDigest.');
}

function memberObservation(
  member: FileEffectRequest['members'][number],
  outcome: FileMemberOutcome,
  actualDigest: string | null,
  error?: string
): FileMutationMemberObservation {
  return {
    memberId: member.memberId,
    memberSeq: member.memberSeq,
    outcome,
    actualDigest,
    ...(error ? { error } : {})
  };
}

function aggregateFileMemberOutcomes(members: FileMutationMemberObservation[]): FileMutationOutcome {
  if (members.length === 0) return 'outcome_unknown';
  const outcomes = members.map((member) => member.outcome);
  const succeeded = outcomes.filter((outcome) => outcome === 'succeeded').length;
  if (succeeded === outcomes.length) return 'succeeded';
  if (succeeded > 0) return 'partial';
  if (outcomes.includes('conflict')) return 'conflict';
  if (outcomes.includes('outcome_unknown')) return 'outcome_unknown';
  if (outcomes.includes('cancelled')) return 'cancelled';
  return 'failed';
}

function fileObservationToEffectOutcome(outcome: FileMutationOutcome): EffectObservedOutcome {
  if (outcome === 'succeeded') return 'succeeded';
  if (outcome === 'conflict') return 'conflict';
  if (outcome === 'cancelled') return 'cancelled';
  if (outcome === 'outcome_unknown') return 'outcome_unknown';
  return 'failed';
}

function fileOutcomeToToolOutcome(outcome: FileMutationOutcome): Exclude<ToolOutcomeStatus, 'rejected'> {
  return outcome;
}

function normalizeProposalMember(input: FileChangeProposalMemberInput): {
  operation: FileChangeOperation;
  workEnvironmentId: string;
  targetPath: string;
  baseDigest: string | null;
  baseContent?: string | Uint8Array;
  baseContentType?: string;
  targetContent?: string | Uint8Array;
  contentType?: string;
} {
  const operation = requireOperation(input.operation);
  const targetContent = input.targetContent;
  if ((operation === 'create_file' || operation === 'replace_file') && targetContent === undefined) {
    throw new TypeError(`${operation} requires targetContent.`);
  }
  if (!(operation === 'create_file' || operation === 'replace_file') && targetContent !== undefined) {
    throw new TypeError(`${operation} cannot carry targetContent.`);
  }
  const baseDigest = input.baseDigest === undefined || input.baseDigest === null
    ? null
    : operation === 'delete_directory_tree' && input.baseDigest === DIRECTORY_DIGEST
      ? DIRECTORY_DIGEST
      : requireSha256(input.baseDigest, 'baseDigest');
  if (operation === 'create_file' || operation === 'create_directory') {
    if (baseDigest !== null) throw new TypeError(`${operation} requires an absent (null) baseDigest.`);
  } else if (operation === 'delete_directory_tree') {
    if (baseDigest !== DIRECTORY_DIGEST) throw new TypeError('delete_directory_tree requires baseDigest="directory".');
  } else if (baseDigest === null) {
    throw new TypeError(`${operation} requires baseDigest.`);
  }
  const requiresFileBase = operation === 'replace_file' || operation === 'delete_file';
  if (requiresFileBase && input.baseContent === undefined) {
    throw new TypeError(`${operation} requires baseContent so its completed Diff remains reproducible.`);
  }
  if (!requiresFileBase && input.baseContent !== undefined) {
    throw new TypeError(`${operation} cannot carry baseContent.`);
  }
  if (input.baseContentType && input.baseContent === undefined) {
    throw new TypeError('baseContentType requires baseContent.');
  }
  return {
    operation,
    workEnvironmentId: requireId(input.workEnvironmentId, 'workEnvironmentId'),
    targetPath: requireText(input.targetPath, 'targetPath'),
    baseDigest,
    ...(input.baseContent !== undefined ? { baseContent: input.baseContent } : {}),
    ...(input.baseContentType ? { baseContentType: requireText(input.baseContentType, 'baseContentType') } : {}),
    ...(targetContent !== undefined ? { targetContent } : {}),
    ...(input.contentType ? { contentType: requireText(input.contentType, 'contentType') } : {})
  };
}

function targetDigestWithoutContent(operation: FileChangeOperation): string | null {
  if (operation === 'create_directory') return DIRECTORY_DIGEST;
  if (operation === 'delete_file' || operation === 'delete_directory_tree') return null;
  throw new Error(`${operation} requires target content.`);
}

function normalizeEffectRequest(value: FileEffectRequest): FileEffectRequest {
  if (!value || typeof value !== 'object' || !Array.isArray(value.members) || value.members.length === 0) {
    throw new TypeError('Invalid file_mutation request.');
  }
  const members = value.members.map((member) => ({
    memberId: requireId(member.memberId, 'memberId'),
    memberSeq: requireDecimalString(member.memberSeq, 'memberSeq'),
    operation: requireOperation(member.operation),
    workEnvironmentId: requireId(member.workEnvironmentId, 'workEnvironmentId'),
    targetPath: requireText(member.targetPath, 'targetPath'),
    baseDigest: nullableDigest(member.baseDigest, 'baseDigest'),
    baseContentObjectId: nullableId(member.baseContentObjectId, 'baseContentObjectId'),
    targetContentObjectId: nullableId(member.targetContentObjectId, 'targetContentObjectId'),
    targetDigest: nullableTargetDigest(member.targetDigest, 'targetDigest')
  })).sort((left, right) => compareDecimalStrings(left.memberSeq, right.memberSeq));
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member.memberSeq !== String(index + 1)) throw new Error('FileChangeSetMember memberSeq must be contiguous from 1.');
    assertEffectRequestMemberShape(member);
  }
  return { changeSetId: requireId(value.changeSetId, 'changeSetId'), members };
}

function assertEffectRequestMemberShape(member: FileEffectRequest['members'][number]): void {
  const hasBaseContent = member.baseContentObjectId !== null;
  const requiresBaseContent = member.operation === 'replace_file' || member.operation === 'delete_file';
  if (hasBaseContent !== requiresBaseContent) {
    throw new Error(`${member.operation} has an invalid base ContentObject reference.`);
  }
  if (requiresBaseContent && (member.baseDigest === null || member.baseDigest === DIRECTORY_DIGEST)) {
    throw new Error(`${member.operation} requires a file baseDigest.`);
  }
  if (!requiresBaseContent && member.baseContentObjectId !== null) {
    throw new Error(`${member.operation} cannot carry base content.`);
  }
  const hasTargetContent = member.targetContentObjectId !== null;
  const requiresTargetContent = member.operation === 'create_file' || member.operation === 'replace_file';
  if (hasTargetContent !== requiresTargetContent) {
    throw new Error(`${member.operation} has an invalid target ContentObject reference.`);
  }
}

function normalizeObservation(value: unknown, changeSetId: string): FileMutationObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid FileMutation observation.');
  const record = value as Record<string, unknown>;
  if (record.changeSetId !== changeSetId || !Array.isArray(record.members)) {
    throw new Error('FileMutation observation belongs to another FileChangeSet.');
  }
  const members = record.members.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Invalid FileMutation member observation.');
    const member = entry as Record<string, unknown>;
    const outcome = requireMemberOutcome(member.outcome);
    return {
      memberId: requireId(member.memberId, 'memberId'),
      memberSeq: requireDecimalString(member.memberSeq, 'memberSeq'),
      outcome,
      actualDigest: nullableTargetDigest(member.actualDigest, 'actualDigest'),
      ...(typeof member.error === 'string' && member.error ? { error: member.error } : {})
    };
  });
  const outcome = requireFileMutationOutcome(record.outcome);
  if (aggregateFileMemberOutcomes(members) !== outcome) throw new Error('FileMutation aggregate outcome does not match member observations.');
  return { changeSetId, outcome, members };
}

function normalizeSource<T extends PhaseDCommandSource['kind']>(
  source: PhaseDCommandSource,
  allowed: readonly T[],
  operation: string
): PhaseDCommandSource & { kind: T } {
  if (!source || !allowed.includes(source.kind as T)) {
    throw new TypeError(`${operation} source kind must be one of: ${allowed.join(', ')}.`);
  }
  return { kind: source.kind as T, key: requireText(source.key, `${operation} source key`) };
}

function sourceReceiptId(source: PhaseDCommandSource, operation: string, scope: string): string {
  return stablePhaseDId('command_receipt', JSON.stringify([source.kind, source.key, operation, scope]));
}

function assertSourceReceipt(receipt: DomainRow, expectedId: string, operation: string): void {
  if (receipt.id !== expectedId) {
    throw new Error(`CommandReceipt (${String(receipt.source_kind)},${String(receipt.source_key)}) does not contain ${operation} result facts.`);
  }
}

function withoutTerminalSteps(plan: Awaited<ReturnType<EffectControlPlane['prepareTerminalPlan']>>): ToolTerminalResult {
  const { steps: _steps, ...result } = plan;
  return result;
}

function matchesExpectedUnique(
  error: unknown,
  expected: ReadonlyArray<readonly [string, readonly string[]]>
): boolean {
  const value = error as { code?: unknown; message?: unknown };
  if (
    typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string'
  ) return false;
  const marker = 'UNIQUE constraint failed:';
  const index = value.message.indexOf(marker);
  if (index < 0) return false;
  const actual = value.message.slice(index + marker.length).split(',').map((entry) => entry.trim()).filter(Boolean).sort();
  return expected.some(([table, columns]) => {
    const wanted = columns.map((column) => `${table}.${column}`).sort();
    return wanted.length === actual.length && wanted.every((column, ordinal) => column === actual[ordinal]);
  });
}

function requireOperation(value: unknown): FileChangeOperation {
  if (!['create_file', 'replace_file', 'delete_file', 'create_directory', 'delete_directory_tree'].includes(String(value))) {
    throw new TypeError(`Unsupported FileChangeSetMember operation: ${String(value)}`);
  }
  return value as FileChangeOperation;
}

function requireDecision(value: unknown): FileChangeDecisionValue {
  if (!['approved', 'rejected', 'cancelled', 'expired'].includes(String(value))) {
    throw new TypeError(`Unsupported FileChangeDecision: ${String(value)}`);
  }
  return value as FileChangeDecisionValue;
}

function requireMemberOutcome(value: unknown): FileMemberOutcome {
  if (!['succeeded', 'failed', 'conflict', 'cancelled', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Unsupported FileMutation member outcome: ${String(value)}`);
  }
  return value as FileMemberOutcome;
}

function requireFileMutationOutcome(value: unknown): FileMutationOutcome {
  if (!['succeeded', 'failed', 'partial', 'conflict', 'cancelled', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Unsupported FileMutation outcome: ${String(value)}`);
  }
  return value as FileMutationOutcome;
}

function nullableDigest(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (value === DIRECTORY_DIGEST) return DIRECTORY_DIGEST;
  return requireSha256(value, label);
}

function nullableTargetDigest(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (value === DIRECTORY_DIGEST || value === 'symlink' || (typeof value === 'string' && value.startsWith('other:'))) return value;
  return requireSha256(value, label);
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireId(value, label);
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return value;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint in JavaScript.`);
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) throw new TypeError(`${label} must be a decimal integer string.`);
  return value;
}

function compareDecimalStrings(left: string, right: string): number {
  return compareBigInts(BigInt(left), BigInt(right));
}

function compareBigInts(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameDigest(left: string | null, right: string | null): boolean {
  return left === right;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

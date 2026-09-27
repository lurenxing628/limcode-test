import { isConversationRuntimeOwnerBusyError, type ConversationRuntimeOwnerBusyError } from '../../reliableKernel/ConversationRuntimeOwnerManager';
import {
  isConversationDeletionBlockedError,
  type ConversationDeleteResult,
  type ConversationDeletionInventory,
  type ConversationDeletionWorkItem
} from '../../reliableKernel/conversationDeletion';
import { isTransactionAssertionFailure } from '../../reliableKernel/phaseFIdentity';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';

/**
 * Deleting a Conversation stops its work first, settles what is still addressed to it or produced
 * by it, then deletes it (the maintainer's rule: a delete never refuses because work still runs).
 *
 * The scope is the Conversation and its whole Subagent tree (ConversationDeletionControlPlane).
 * Every piece of work goes through an existing stop transition, none of which needs the
 * Conversation's ownership, so a window other than the one executing it can issue it:
 *
 * | Work in the scope (in this order, every round)     | Transition                                                  |
 * |----------------------------------------------------|-------------------------------------------------------------|
 * | queued user message                                | TurnControlPlane.cancelGuidanceForDeletion (revision fence); nothing below runs until every cancellation landed, so no ending Turn admits one |
 * | active top-level Turn: the durable stop request    | TurnControlPlane.requestExternalInterrupt                   |
 * | child Agent with work, outermost, with its subtree | ReliableChildAgentCoordinator.interruptSubtree, `userStop`, a new source key per attempt |
 * | active top-level Turn: executing the stop          | ReliableConversationRunner.interrupt (live owner, dead host, outcome_unknown) |
 * | running background process                         | ProcessControlPlane.stopOwnedProcess (the wrapper's stop request file) |
 * | child answer a parent Turn in a model request is taking in | none: the deletion waits for that request boundary |
 *
 * The parents' stop requests are durable before the subtree is interrupted, so a parent whose wait
 * for a child ends terminates instead of calling the model again; the subtree is interrupted before
 * any parent Turn actually ends, so no child finishing normally continues a stopped parent.
 * While the command runs, this window opens no continuation Turn in the scope
 * (ConversationDeletionControlPlane.markStopping): a stopped background process of an idle
 * Conversation reports its end to nobody. The window that owns a Conversation runs its wakes, so a
 * live other window that owns one may still open that Turn; the deletion then stops it as well.
 * A live owner executes what it was asked; a dead owner's work is closed by the stop paths above.
 * The command waits until nothing runs, at most `timeoutMs`, re-issuing stops that did not land,
 * and reports progress (stopping, waiting for another window, waiting for a parent's request).
 * When work does not stop in time the Conversation is not deleted and
 * ConversationDeleteIncompleteError names what still runs, where, and whether its stop request was
 * sent; the requests stay, so deleting again after it stopped completes.
 */
export const CONVERSATION_DELETE_STOP_REASON = '用户删除对话';
/** The reason a parent outside the scope sees when its wait for the deleted child ends. */
export const CHILD_CONVERSATION_DELETE_REASON = '用户删除子任务对话';
export const CONVERSATION_DELETE_PROGRESS_TITLE = '正在停止这个对话里的任务，停好后自动删除';
export const CONVERSATION_DELETE_STOP_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 250;
/** A stop that has not landed is issued again after this long (dead-host checks, late spawns). */
const RESTOP_AFTER_MS = 3_000;

export type ConversationDeleteProgress =
  /** Work of the scope is being stopped. */
  | { kind: 'stopping'; message: string }
  /** Nothing runs, but another window still holds the Conversation. */
  | { kind: 'waiting_owner'; message: string }
  /** A parent Turn outside the scope is in a model request and takes the child's answer in at its end. */
  | { kind: 'waiting_parent'; message: string };

export interface ConversationDeleteCommandDependencies {
  application: ReliableKernelApplication;
  conversations: {
    interrupt(input: { commandId: string; conversationId: string; turnId: string; reason: string }): Promise<unknown>;
  };
  childAgents: {
    interruptSubtree(
      input: { sourceKey: string; childExecutionId: string; reason: string },
      options: { userStop?: boolean }
    ): Promise<unknown>;
  };
  timeoutMs?: number;
  pollMs?: number;
}

export interface ConversationDeleteRemainingWork {
  kind: ConversationDeletionWorkItem['kind'] | 'owner' | 'error';
  conversationId: string;
  id: string;
  detail: string;
  /** The stop request of this work was written (it is not for 'owner', 'parent_intake' and 'error'). */
  stopRequested: boolean;
}

/** The work did not stop in time: nothing was deleted; the stop requests that were sent stay. */
export class ConversationDeleteIncompleteError extends Error {
  public readonly code = 'conversation-delete-incomplete';

  public constructor(message: string, public readonly remaining: ConversationDeleteRemainingWork[]) {
    super(message);
    this.name = 'ConversationDeleteIncompleteError';
  }
}

export function isConversationDeleteIncompleteError(error: unknown): error is ConversationDeleteIncompleteError {
  return error instanceof ConversationDeleteIncompleteError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'conversation-delete-incomplete');
}

/**
 * Stops, settles and deletes. `onProgress` is called whenever what the command waits for changes
 * (never when the Conversation is deleted at once). Null when the Conversation does not exist.
 */
export async function stopAndDeleteConversation(
  dependencies: ConversationDeleteCommandDependencies,
  input: { conversationId: string; requestId: string; onProgress?: (progress: ConversationDeleteProgress) => void }
): Promise<ConversationDeleteResult | null> {
  return new ConversationDeleteCommand(dependencies, input.conversationId, input.requestId, input.onProgress).run();
}

class ConversationDeleteCommand {
  private readonly issuedAt = new Map<string, number>();
  /** Work whose stop request was written, by `${kind}:${id}`. */
  private readonly requested = new Set<string>();
  private readonly failures = new Map<string, Omit<ConversationDeleteRemainingWork, 'stopRequested'>>();
  private readonly attempts = new Map<string, number>();
  private busy: ConversationRuntimeOwnerBusyError | undefined;
  private lastProgress: string | undefined;

  public constructor(
    private readonly dependencies: ConversationDeleteCommandDependencies,
    private readonly conversationId: string,
    private readonly requestId: string,
    private readonly onProgress?: (progress: ConversationDeleteProgress) => void
  ) {}

  public async run(): Promise<ConversationDeleteResult | null> {
    const releases: Array<() => void> = [];
    try {
      return await this.stopAndDelete(releases);
    } finally {
      for (const release of releases) release();
    }
  }

  private async stopAndDelete(releases: Array<() => void>): Promise<ConversationDeleteResult | null> {
    const { application } = this.dependencies;
    const deadline = Date.now() + (this.dependencies.timeoutMs ?? CONVERSATION_DELETE_STOP_TIMEOUT_MS);
    const marked = new Set<string>();
    for (;;) {
      const inventory = await application.conversationDeletion.inspect(this.conversationId);
      if (!inventory) return null;
      // What this command stops reports its end to no new Turn while it runs (markStopping).
      const unmarked = inventory.conversationIds.filter((id) => !marked.has(id));
      if (unmarked.length > 0) {
        releases.push(application.conversationDeletion.markStopping(unmarked));
        for (const id of unmarked) marked.add(id);
      }
      if (inventory.work.length === 0) {
        try {
          // The facade boundary guard: the requested id is pinned; the control plane pins the rest.
          return await application.database.conversationOwners.run(this.conversationId, () =>
            application.conversationDeletion.delete(this.conversationId));
        } catch (error) {
          if (isConversationRuntimeOwnerBusyError(error)) {
            // Nothing runs, but another window holds the Conversation (it releases an idle one).
            this.busy = error;
            this.progress({
              kind: 'waiting_owner',
              message: `对话${title(inventory, error.conversationId)}正被另一个窗口（进程 ${error.owner.processId}）使用，它释放后自动删除`
            });
          } else if (!isConversationDeletionBlockedError(error) && !isTransactionAssertionFailure(error)) {
            // Work or a result appeared meanwhile: the next round sees it.
            throw error;
          }
        }
      } else {
        this.busy = undefined;
        if (inventory.work.every((item) => item.kind === 'parent_intake')) {
          const parent = inventory.work[0].conversationId;
          this.progress({
            kind: 'waiting_parent',
            message: `父对话${title(inventory, parent)}正在等模型回复，回复后它会接收子任务的答复，然后自动删除`
          });
        } else {
          this.progress({ kind: 'stopping', message: CONVERSATION_DELETE_PROGRESS_TITLE });
          await this.issueStops(inventory);
        }
      }
      if (Date.now() >= deadline) throw await this.incomplete(inventory);
      await sleep(this.dependencies.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  private progress(progress: ConversationDeleteProgress): void {
    const key = `${progress.kind}:${progress.message}`;
    if (this.lastProgress === key) return;
    this.lastProgress = key;
    this.onProgress?.(progress);
  }

  private async issueStops(inventory: ConversationDeletionInventory): Promise<void> {
    const { application, conversations, childAgents } = this.dependencies;
    const prefix = `conversation-delete:${this.requestId}`;
    // Queued messages first, and nothing else until every cancellation landed: a Turn that ends
    // (here or in the window executing it) must find no queued message to admit.
    let queuedLeft = false;
    for (const item of inventory.work.filter((entry) => entry.kind === 'queued_message')) {
      const landed = await this.issue(item, 'cancel', () => application.turns.cancelGuidanceForDeletion({
        source: { kind: 'command', key: `${prefix}:message:${item.id}:${item.revisionSeq ?? '0'}` },
        conversationId: item.conversationId,
        intentId: item.id,
        expectedRevisionSeq: item.revisionSeq ?? '0'
      }), true);
      if (!landed) queuedLeft = true;
    }
    if (queuedLeft) return;
    const turns = inventory.work.filter((entry) => entry.kind === 'turn');
    // The durable stop requests of the parents first: a parent whose wait for a child ends below
    // terminates at its next check instead of calling the model again.
    for (const item of turns) {
      await this.issue(item, 'request', () => application.turns.requestExternalInterrupt(item.conversationId, {
        source: { kind: 'command', key: `${prefix}:turn:${item.id}` },
        turnId: item.id,
        reason: CONVERSATION_DELETE_STOP_REASON
      }));
    }
    // Then every child subtree, before any parent Turn ends: a child finishing now answers a parent
    // that is still running (its stop takes the answer in), never one that already stopped.
    for (const childExecutionId of outermostChildrenWithWork(inventory)) {
      const item = inventory.work.find((entry) => entry.childExecutionId === childExecutionId)!;
      const target = { ...item, kind: 'child_execution' as const, id: childExecutionId };
      await this.issue(target, 'interrupt', () => {
        // A new source key per attempt: a replay of an earlier one would not reach a Turn started since.
        const attempt = (this.attempts.get(childExecutionId) ?? 0) + 1;
        this.attempts.set(childExecutionId, attempt);
        return childAgents.interruptSubtree({
          sourceKey: `${prefix}:child:${childExecutionId}:${attempt}`,
          childExecutionId,
          // The parent outside the scope receives this as the result of its wait for the child.
          reason: childExecutionId === inventory.rootChildExecutionId
            ? CHILD_CONVERSATION_DELETE_REASON
            : CONVERSATION_DELETE_STOP_REASON
        }, { userStop: true });
      });
    }
    // Then each parent's stop is executed: by this window, its live owner, or as a dead host's.
    for (const item of turns) {
      await this.issue(item, 'drive', () => conversations.interrupt({
        commandId: `${prefix}:turn:${item.id}`,
        conversationId: item.conversationId,
        turnId: item.id,
        reason: CONVERSATION_DELETE_STOP_REASON
      }));
    }
    // A process stop is a request file for the wrapper (nonce, fingerprint and PID-reuse fenced):
    // any window writes it, whichever window holds the Conversation.
    for (const item of inventory.work.filter((entry) => entry.kind === 'process')) {
      await this.issue(item, 'stop', async () => {
        const stopped = await application.processes.stopOwnedProcess(item.id);
        if (stopped.receipt) await application.processes.reconcileProcessExit(item.id);
      });
    }
  }

  /**
   * Issues one stop, again only after RESTOP_AFTER_MS unless `everyRound`. Returns whether it
   * landed; a failure is kept for the message and retried.
   */
  private async issue(
    item: ConversationDeletionWorkItem,
    step: string,
    stop: () => Promise<unknown>,
    everyRound = false
  ): Promise<boolean> {
    const key = `${step}:${item.kind}:${item.id}`;
    const workKey = `${item.kind}:${item.id}`;
    const last = this.issuedAt.get(key);
    const now = Date.now();
    if (!everyRound && last !== undefined && now - last < RESTOP_AFTER_MS) return true;
    this.issuedAt.set(key, now);
    try {
      await stop();
      this.failures.delete(workKey);
      this.requested.add(workKey);
      return true;
    } catch (error) {
      this.failures.set(workKey, {
        kind: 'error',
        conversationId: item.conversationId,
        id: item.id,
        detail: isConversationRuntimeOwnerBusyError(error)
          ? `另一个窗口（进程 ${error.owner.processId}）占用着对话，没能发出停止请求`
          : error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async incomplete(inventory: ConversationDeletionInventory): Promise<ConversationDeleteIncompleteError> {
    const remaining: ConversationDeleteRemainingWork[] = [];
    const lines = new Set<string>();
    let anyRequested = false;
    for (const item of inventory.work) {
      // A child's work is stopped through the outermost interrupted subtree that covers it.
      const workKey = item.childExecutionId
        ? `child_execution:${outermostCovering(inventory, item.childExecutionId)}`
        : `${item.kind}:${item.id}`;
      const stopRequested = item.kind !== 'parent_intake' && this.requested.has(workKey);
      let detail: string;
      if (item.kind === 'turn' || item.kind === 'child_turn') {
        const owner = item.kind === 'turn' ? `对话${title(inventory, item.conversationId)}的回合` : `子任务${title(inventory, item.conversationId)}的回合`;
        const tools = item.executingTools?.length ? `，工具 ${item.executingTools.join('、')} 还没有返回` : '';
        detail = `${owner}${await this.where(item.hostBootId, stopRequested)}${tools}`;
      } else if (item.kind === 'child_execution' || item.kind === 'parent_wait') {
        detail = `子任务${title(inventory, item.conversationId)}还在停止中`;
      } else if (item.kind === 'child_continuation') {
        detail = `子任务${title(inventory, item.conversationId)}还有排队的后续任务`;
      } else if (item.kind === 'queued_message') {
        detail = `对话${title(inventory, item.conversationId)}还有排队的消息没能取消`;
      } else if (item.kind === 'parent_intake') {
        detail = `父对话${title(inventory, item.conversationId)}的模型回复还没结束，它要先接收子任务的答复`;
      } else {
        detail = `对话${title(inventory, item.conversationId)}的后台进程 ${item.id} 还在运行`;
      }
      if (item.kind !== 'parent_intake') detail += stopRequested ? '（已发出停止请求）' : '（还没能发出停止请求）';
      anyRequested ||= stopRequested;
      remaining.push({ kind: item.kind, conversationId: item.conversationId, id: item.id, detail, stopRequested });
      lines.add(detail);
    }
    if (inventory.work.length === 0 && this.busy) {
      const detail = `对话${title(inventory, this.busy.conversationId)}正被另一个窗口（进程 ${this.busy.owner.processId}）使用`;
      remaining.push({ kind: 'owner', conversationId: this.busy.conversationId, id: this.busy.owner.hostBootId, detail, stopRequested: false });
      lines.add(detail);
    }
    for (const failure of this.failures.values()) {
      const detail = `停止对话${title(inventory, failure.conversationId)}里的任务时出错：${failure.detail}`;
      remaining.push({ ...failure, detail, stopRequested: false });
      lines.add(detail);
    }
    if (lines.size === 0) lines.add('对话里的任务还没有全部停下');
    const tail = anyRequested
      ? '停止请求已经发出，等它停下后再删除一次。'
      : this.busy && inventory.work.length === 0
        ? '那个窗口释放这个对话后再删除一次。'
        : '等它结束后再删除一次。';
    return new ConversationDeleteIncompleteError(`删除没有完成：${[...lines].join('；')}。${tail}`, remaining);
  }

  /** Where the Turn runs; it says the Turn is stopping only once its stop request was written. */
  private async where(hostBootId: string | undefined, stopRequested: boolean): Promise<string> {
    const database = this.dependencies.application.database;
    if (!hostBootId) return stopRequested ? '还在停止中' : '还在进行';
    if (hostBootId === database.hostBootId) return stopRequested ? '正在本窗口停止' : '正在本窗口执行';
    const processId = await database.hostProcessId(hostBootId).catch(() => undefined);
    const alive = await database.isHostAlive(hostBootId).catch(() => true);
    const window = processId === undefined ? '另一个窗口' : `另一个窗口（进程 ${processId}）`;
    if (alive) return `仍在${window}中执行`;
    return stopRequested ? `仍由已退出的${window}持有，停止还在收尾` : `仍由已退出的${window}持有`;
  }
}

function title(inventory: ConversationDeletionInventory, conversationId: string): string {
  const text = inventory.conversationTitles[conversationId]?.trim();
  return text ? `「${text}」` : `「${conversationId}」`;
}

/**
 * The child Agents to interrupt: each ChildExecution of the scope that has work, unless an ancestor
 * in the scope is interrupted too (interruptSubtree covers the whole subtree).
 */
function outermostChildrenWithWork(inventory: ConversationDeletionInventory): string[] {
  const withWork = new Set(inventory.work.flatMap((item) =>
    item.childExecutionId && item.kind !== 'parent_intake' ? [item.childExecutionId] : []));
  return [...withWork].sort().filter((childExecutionId) => outermostCovering(inventory, childExecutionId, withWork) === childExecutionId);
}

/** The outermost ChildExecution with work whose subtree covers this one (itself when none does). */
function outermostCovering(
  inventory: ConversationDeletionInventory,
  childExecutionId: string | undefined,
  withWork = new Set(inventory.work.flatMap((item) => item.childExecutionId ? [item.childExecutionId] : []))
): string {
  if (!childExecutionId) return '';
  const parentOf = new Map(inventory.childExecutions.map((child) => [child.id, child.parentChildExecutionId]));
  let outermost = childExecutionId;
  let ancestor = parentOf.get(childExecutionId) ?? null;
  const seen = new Set<string>([childExecutionId]);
  while (ancestor !== null && !seen.has(ancestor)) {
    if (withWork.has(ancestor)) outermost = ancestor;
    seen.add(ancestor);
    ancestor = parentOf.get(ancestor) ?? null;
  }
  return outermost;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

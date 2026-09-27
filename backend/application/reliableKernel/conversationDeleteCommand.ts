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
 * Every piece of work goes through the existing user-stop transition, with the reason "对话已删除":
 *
 * | Work in the scope                                  | Transition                                                  |
 * |----------------------------------------------------|-------------------------------------------------------------|
 * | queued user message (first: no ending Turn admits it) | ReliableConversationRunner.cancelGuidance                 |
 * | active top-level Turn, its question or approval    | ReliableConversationRunner.interrupt (live owner, dead host, outcome_unknown) |
 * | child Agent with work (Turn, continuation, parent wait) | ReliableChildAgentCoordinator.interruptSubtree, `userStop`, outermost first |
 * | running background process                         | ProcessControlPlane.stopOwnedProcess, as the process panel does |
 * | child answer a running parent Turn outside the scope is taking in | none: the deletion waits for that Turn |
 *
 * A stop is a control operation: any window issues it, a live owner executes it, a dead owner's
 * work is closed by the stop paths above (outcome_unknown). The command then waits until nothing
 * runs, at most `timeoutMs`, re-issuing stops that did not land. When the requested Conversation is
 * a child Agent whose parent stays, the parent's wait for it is cancelled with "子任务对话已被用户删除"
 * (a running parent Turn continues with that result) and its answer the parent had not taken in is
 * settled in the deletion transaction. When work does not stop in time the Conversation is not
 * deleted and ConversationDeleteIncompleteError names what still runs and where; the stop requests
 * stay, so deleting again after it stopped completes.
 */
export const CONVERSATION_DELETED_STOP_REASON = '对话已删除';
export const CHILD_CONVERSATION_DELETED_REASON = '子任务对话已被用户删除';
export const CONVERSATION_DELETE_PROGRESS_TITLE = '正在停止这个对话里的任务，停好后自动删除';
export const CONVERSATION_DELETE_STOP_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 250;
/** A stop that has not landed is issued again after this long (dead-host checks, late spawns). */
const RESTOP_AFTER_MS = 3_000;
/**
 * Children are interrupted once the scope's top-level Turns ended, or after this long: a parent
 * Turn that ends first takes no partial answer of a child that is stopping at the same moment.
 */
const CHILD_STOP_AFTER_PARENT_MS = 2_000;

export interface ConversationDeleteCommandDependencies {
  application: ReliableKernelApplication;
  conversations: {
    interrupt(input: { commandId: string; conversationId: string; turnId: string; reason: string }): Promise<unknown>;
    cancelGuidance(input: { commandId: string; conversationId: string; intentId: string; expectedRevisionSeq: string }): Promise<unknown>;
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
}

/** The work did not stop in time: nothing was deleted; the stop requests stay. */
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
 * Stops, settles and deletes. `onStopping` is called once, only when work had to be stopped (the
 * product shows its progress notification then). Null when the Conversation does not exist.
 */
export async function stopAndDeleteConversation(
  dependencies: ConversationDeleteCommandDependencies,
  input: { conversationId: string; requestId: string; onStopping?: () => void }
): Promise<ConversationDeleteResult | null> {
  return new ConversationDeleteCommand(dependencies, input.conversationId, input.requestId).run(input.onStopping);
}

class ConversationDeleteCommand {
  private readonly issuedAt = new Map<string, number>();
  private readonly failures = new Map<string, ConversationDeleteRemainingWork>();
  private busy: ConversationRuntimeOwnerBusyError | undefined;
  private firstParentStopAt: number | undefined;

  public constructor(
    private readonly dependencies: ConversationDeleteCommandDependencies,
    private readonly conversationId: string,
    private readonly requestId: string
  ) {}

  public async run(onStopping?: () => void): Promise<ConversationDeleteResult | null> {
    const { application } = this.dependencies;
    const deadline = Date.now() + (this.dependencies.timeoutMs ?? CONVERSATION_DELETE_STOP_TIMEOUT_MS);
    let announced = false;
    for (;;) {
      const inventory = await application.conversationDeletion.inspect(this.conversationId);
      if (!inventory) return null;
      if (inventory.work.length === 0) {
        try {
          // The facade boundary guard: the requested id is pinned; the control plane pins the rest.
          return await application.database.conversationOwners.run(this.conversationId, () =>
            application.conversationDeletion.delete(this.conversationId));
        } catch (error) {
          // Another window still holds the Conversation, or work or a result appeared meanwhile.
          if (isConversationRuntimeOwnerBusyError(error)) this.busy = error;
          else if (!isConversationDeletionBlockedError(error) && !isTransactionAssertionFailure(error)) throw error;
        }
      } else {
        this.busy = undefined;
        if (!announced) {
          announced = true;
          onStopping?.();
        }
        await this.issueStops(inventory);
      }
      if (Date.now() >= deadline) throw await this.incomplete(inventory);
      await sleep(this.dependencies.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  private async issueStops(inventory: ConversationDeletionInventory): Promise<void> {
    const { application, conversations, childAgents } = this.dependencies;
    const prefix = `conversation-delete:${this.requestId}`;
    // A queued message goes first, so no Turn that ends below admits it.
    for (const item of inventory.work.filter((entry) => entry.kind === 'queued_message')) {
      await this.once(item, () => conversations.cancelGuidance({
        commandId: `${prefix}:message:${item.id}`,
        conversationId: item.conversationId,
        intentId: item.id,
        expectedRevisionSeq: item.revisionSeq ?? '0'
      }));
    }
    // Parents before children: an interrupted child's partial answer then only notifies a stopped parent.
    for (const item of inventory.work.filter((entry) => entry.kind === 'turn')) {
      await this.once(item, () => conversations.interrupt({
        commandId: `${prefix}:turn:${item.id}`,
        conversationId: item.conversationId,
        turnId: item.id,
        reason: CONVERSATION_DELETED_STOP_REASON
      }));
    }
    for (const item of inventory.work.filter((entry) => entry.kind === 'process')) {
      await this.once(item, () => application.database.conversationOwners.run(item.conversationId, async () => {
        const stopped = await application.processes.stopOwnedProcess(item.id);
        if (stopped.receipt) await application.processes.reconcileProcessExit(item.id);
      }));
    }
    const parentTurns = inventory.work.some((entry) => entry.kind === 'turn');
    if (parentTurns) this.firstParentStopAt ??= Date.now();
    if (parentTurns && Date.now() - this.firstParentStopAt! < CHILD_STOP_AFTER_PARENT_MS) return;
    for (const childExecutionId of outermostChildrenWithWork(inventory)) {
      const item = inventory.work.find((entry) => entry.childExecutionId === childExecutionId)!;
      await this.once({ ...item, kind: 'child_execution', id: childExecutionId }, () => childAgents.interruptSubtree({
        sourceKey: `${prefix}:child:${childExecutionId}`,
        childExecutionId,
        // The parent outside the scope receives this as the result of its wait for the child.
        reason: childExecutionId === inventory.rootChildExecutionId
          ? CHILD_CONVERSATION_DELETED_REASON
          : CONVERSATION_DELETED_STOP_REASON
      }, { userStop: true }));
    }
  }

  /** Issues one stop, again only after RESTOP_AFTER_MS; a failure is kept for the message and retried. */
  private async once(item: ConversationDeletionWorkItem, stop: () => Promise<unknown>): Promise<void> {
    const key = `${item.kind}:${item.id}`;
    const last = this.issuedAt.get(key);
    const now = Date.now();
    if (last !== undefined && now - last < RESTOP_AFTER_MS) return;
    this.issuedAt.set(key, now);
    try {
      await stop();
      this.failures.delete(key);
    } catch (error) {
      // A live window holds it: that window executes the durable stop request.
      if (isConversationRuntimeOwnerBusyError(error)) return;
      this.failures.set(key, {
        kind: 'error',
        conversationId: item.conversationId,
        id: item.id,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async incomplete(inventory: ConversationDeletionInventory): Promise<ConversationDeleteIncompleteError> {
    const title = (conversationId: string) => {
      const text = inventory.conversationTitles[conversationId]?.trim();
      return text ? `「${text}」` : `「${conversationId}」`;
    };
    const remaining: ConversationDeleteRemainingWork[] = [];
    const lines = new Set<string>();
    for (const item of inventory.work) {
      let detail: string;
      if (item.kind === 'turn' || item.kind === 'child_turn') {
        const owner = item.kind === 'turn' ? `对话${title(item.conversationId)}的回合` : `子任务${title(item.conversationId)}的回合`;
        const tools = item.executingTools?.length ? `，工具 ${item.executingTools.join('、')} 还没有返回` : '';
        detail = `${owner}${await this.where(item.hostBootId)}${tools}`;
      } else if (item.kind === 'child_execution' || item.kind === 'parent_wait') {
        detail = `子任务${title(item.conversationId)}还在停止中`;
      } else if (item.kind === 'child_continuation') {
        detail = `子任务${title(item.conversationId)}还有排队的后续任务`;
      } else if (item.kind === 'parent_intake') {
        detail = `父对话${title(item.conversationId)}正在接收子任务的答复`;
      } else if (item.kind === 'queued_message') {
        detail = `对话${title(item.conversationId)}还有排队的消息`;
      } else {
        detail = `对话${title(item.conversationId)}的后台进程 ${item.id} 还在运行`;
      }
      remaining.push({ kind: item.kind, conversationId: item.conversationId, id: item.id, detail });
      lines.add(detail);
    }
    if (inventory.work.length === 0 && this.busy) {
      const detail = `另一个窗口（进程 ${this.busy.owner.processId}）仍占用对话${title(this.busy.conversationId)}`;
      remaining.push({ kind: 'owner', conversationId: this.busy.conversationId, id: this.busy.owner.hostBootId, detail });
      lines.add(detail);
    }
    for (const failure of this.failures.values()) {
      const detail = `停止对话${title(failure.conversationId)}里的任务时出错：${failure.detail}`;
      remaining.push({ ...failure, detail });
      lines.add(detail);
    }
    if (lines.size === 0) lines.add('对话里的任务还没有全部停下');
    return new ConversationDeleteIncompleteError(
      `删除没有完成：${[...lines].join('；')}。停止请求已经发出，等它停下后再删除一次。`,
      remaining
    );
  }

  private async where(hostBootId: string | undefined): Promise<string> {
    const database = this.dependencies.application.database;
    if (!hostBootId) return '还在停止中';
    if (hostBootId === database.hostBootId) return '正在本窗口停止';
    const processId = await database.hostProcessId(hostBootId).catch(() => undefined);
    const alive = await database.isHostAlive(hostBootId).catch(() => true);
    const window = processId === undefined ? '另一个窗口' : `另一个窗口（进程 ${processId}）`;
    return alive ? `仍在${window}中执行` : `仍由已退出的${window}持有，停止还在收尾`;
  }
}

/**
 * The child Agents to interrupt: each ChildExecution of the scope that has work, unless an ancestor
 * in the scope is interrupted too (interruptSubtree covers the whole subtree).
 */
function outermostChildrenWithWork(inventory: ConversationDeletionInventory): string[] {
  const withWork = new Set(inventory.work.flatMap((item) => item.childExecutionId ? [item.childExecutionId] : []));
  const parentOf = new Map(inventory.childExecutions.map((child) => [child.id, child.parentChildExecutionId]));
  const result: string[] = [];
  for (const childExecutionId of [...withWork].sort()) {
    let ancestor = parentOf.get(childExecutionId) ?? null;
    let covered = false;
    const seen = new Set<string>([childExecutionId]);
    while (ancestor !== null && !seen.has(ancestor)) {
      if (withWork.has(ancestor)) {
        covered = true;
        break;
      }
      seen.add(ancestor);
      ancestor = parentOf.get(ancestor) ?? null;
    }
    if (!covered) result.push(childExecutionId);
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

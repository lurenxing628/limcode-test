import type { AttachmentIngestService } from './attachmentIngest';
import { CollaborationControlPlane } from './collaborationControlPlane';
import { CollaborationBoard } from './collaborationBoard';
import {
  AnswerControlPlane,
  RuntimeDeliveryControlPlane,
  type AnswerSubmitCommand,
  type RuntimeDeliveryCreateCommand
} from './answerDelivery';
import {
  ChildExecutionControlPlane,
  type ChildContinuationAdmissionCommand,
  type ChildExecutionCancelCommand,
  type ChildExecutionSendCommand,
  type ChildExecutionSpawnCommand
} from './childExecution';
import {
  BoundedClientFeed,
  ClientDetailReader,
  ClientHistoryReader
} from './clientFeed';
import { ConversationForkControlPlane } from './conversationFork';
import { ContentAddressedStore } from './contentAddressedStore';
import { EffectControlPlane, type EffectObservedOutcome } from './effectControlPlane';
import { PhaseFRecoveryScanner } from './phaseFRecovery';
import { requirePhaseFId, requirePhaseFText } from './phaseFIdentity';
import { RuntimeDatabase } from './runtimeDatabase';
import type { TurnAuthorityCompiler } from './turnControlPlane';

export interface ReliableKernelRuntimeServices {
  effects: EffectControlPlane;
  conversationFork: ConversationForkControlPlane;
  deliveries: RuntimeDeliveryControlPlane;
  collaboration: CollaborationControlPlane;
  collaborationBoard: CollaborationBoard;
  children: ChildExecutionControlPlane;
  answers: AnswerControlPlane;
  recovery: PhaseFRecoveryScanner;
  clientFeed: BoundedClientFeed;
  history: ClientHistoryReader;
  details: ClientDetailReader;
  router: ReliableKernelRuntimeRouter;
}

/**
 * 正式 Runtime 服务组合。其 import closure 只包含 SQLite/CAS 可靠内核服务，不依赖旧文件
 * writer、AgentRun authority、run-history router 或完整 ClientState 数据库副本。
 */
export function createReliableKernelRuntimeServices(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  options: {
    now?: () => string;
    authorityCompiler: TurnAuthorityCompiler;
    attachments?: AttachmentIngestService;
  }
): ReliableKernelRuntimeServices {
  const effects = new EffectControlPlane(database, contentStore, options);
  const deliveries = new RuntimeDeliveryControlPlane(database, contentStore, options);
  const collaboration = new CollaborationControlPlane(database, contentStore, deliveries, options);
  const collaborationBoard = new CollaborationBoard(database, contentStore, {
    ...options,
    notify: notice => collaboration.notifyBoardPost(notice)
  });
  const children = new ChildExecutionControlPlane(database, contentStore, effects, {
    ...options,
    prepareNextTurnDeliverySteps: (conversationId, turnId, now) =>
      deliveries.prepareNextTurnDeliverySteps(conversationId, turnId, now)
  });
  const answers = new AnswerControlPlane(database, contentStore, children, options);
  const conversationFork = new ConversationForkControlPlane(database, contentStore, options);
  const recovery = new PhaseFRecoveryScanner(database, answers, deliveries, children, options);
  const clientFeed = new BoundedClientFeed(database);
  const history = new ClientHistoryReader(database);
  const details = new ClientDetailReader(database, contentStore);
  const router = new ReliableKernelRuntimeRouter({
    collaboration,
    collaborationBoard,
    conversationFork,
    children,
    answers,
    deliveries,
    recovery,
    clientFeed,
    history,
    details
  });
  return {
    collaboration,
    collaborationBoard,
    effects,
    conversationFork,
    deliveries,
    children,
    answers,
    recovery,
    clientFeed,
    history,
    details,
    router
  };
}

export type RunAgentRouteCommand =
  | ({ operation: 'spawn' } & ChildExecutionSpawnCommand)
  | ({ operation: 'send' } & ChildExecutionSendCommand)
  | ({ operation: 'admit' } & ChildContinuationAdmissionCommand)
  | ({ operation: 'wait'; childExecutionId: string; timeoutMs?: number })
  | ({ operation: 'list'; limit?: number })
  | ({ operation: 'interrupt_subtree' } & ChildExecutionCancelCommand);

type RuntimeRouterServices = Omit<ReliableKernelRuntimeServices, 'effects' | 'router'>;

/** 固定路由表；未知操作显式失败，绝不 fallback 到旧 Runtime。 */
export class ReliableKernelRuntimeRouter {
  public constructor(private readonly services: RuntimeRouterServices) {}

  public runAgent(command: RunAgentRouteCommand): Promise<unknown> {
    switch (command.operation) {
      case 'spawn': {
        const { operation: _operation, ...input } = command;
        return this.services.children.spawn(input);
      }
      case 'send': {
        const { operation: _operation, ...input } = command;
        return this.services.children.send(input);
      }
      case 'admit': {
        const { operation: _operation, ...input } = command;
        return this.services.children.admitQueuedIntent(input);
      }
      case 'wait':
        return this.services.children.wait(command.childExecutionId, command.timeoutMs ?? 0);
      case 'list':
        return this.services.children.list(command.limit ?? 200);
      case 'interrupt_subtree': {
        const { operation: _operation, ...input } = command;
        return this.services.children.interruptSubtree(input);
      }
      default:
        return Promise.reject(new Error(`Unsupported run_agent operation: ${String((command as { operation?: unknown }).operation)}.`));
    }
  }

  public submitAnswer(command: AnswerSubmitCommand) {
    return this.services.answers.submit(command);
  }

  public createDelivery(command: RuntimeDeliveryCreateCommand) {
    return this.services.deliveries.create(command);
  }


  public runRecovery(id: Parameters<PhaseFRecoveryScanner['run']>[0]) {
    return this.services.recovery.run(id);
  }

  public connectClient(input: Parameters<BoundedClientFeed['connect']>[0]) {
    return this.services.clientFeed.connect(input);
  }

  public acknowledgeClient(input: Parameters<BoundedClientFeed['acknowledge']>[0]): void {
    this.services.clientFeed.acknowledge(input);
  }

  /** 直接返回六类权威 UI 事实，不从 activity stage、display text 或无关 input 推断。 */
  public async childExecutionUiFacts(childExecutionIdInput: string, deliveryId?: string): Promise<{
    childExecutionState: string;
    activeChildTurnState: string | null;
    answerSubmissionState: string;
    runtimeDeliveryState: string | null;
    parentHandlingState: string | null;
    terminationState: string | null;
    childConversationId: string;
    answerBridgeId: string;
  }> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const snapshot = await this.services.children.readExecutionSnapshot(childExecutionId);
    const delivery = deliveryId
      ? await this.services.deliveries.summary(requirePhaseFId(deliveryId, 'deliveryId'))
      : null;
    return {
      childExecutionState: requirePhaseFText(snapshot.childExecution.status, 'ChildExecution.status'),
      activeChildTurnState: snapshot.activeTurn ? requirePhaseFText(snapshot.activeTurn.status, 'Turn.status') : null,
      answerSubmissionState: snapshot.currentSubmission ? 'submitted' : 'none',
      runtimeDeliveryState: delivery ? requirePhaseFText(delivery.delivery.state, 'RuntimeDelivery.state') : null,
      parentHandlingState: delivery?.parentHandlingState ?? null,
      terminationState: snapshot.activeTurn?.status === 'terminated' ? 'terminated' : null,
      childConversationId: requirePhaseFId(snapshot.childExecution.child_conversation_id, 'ChildExecution.child_conversation_id'),
      answerBridgeId: requirePhaseFId(snapshot.answerBridge.id, 'AnswerBridge.id')
    };
  }
}

export interface SubagentSpawnAdapterResult {
  outcome: EffectObservedOutcome;
  detail?: unknown;
}

export class SubagentSpawnDispatchError extends Error {
  public constructor(
    message: string,
    public readonly dispatched: boolean
  ) {
    super(message);
    this.name = 'SubagentSpawnDispatchError';
  }
}

/** Dispatch helper with explicit unknown-after-dispatch classification and no automatic retry. */
export async function dispatchPreparedSubagentSpawn(input: {
  services: ReliableKernelRuntimeServices;
  effectIntentId: string;
  attemptId: string;
  callbackKey: string;
  adapter: { spawn(request: unknown): Promise<SubagentSpawnAdapterResult> };
}): Promise<Awaited<ReturnType<ChildExecutionControlPlane['reconcileSpawnReceipt']>>> {
  const effectIntentId = requirePhaseFId(input.effectIntentId, 'effectIntentId');
  const attemptId = requirePhaseFId(input.attemptId, 'attemptId');
  const claimed = await input.services.children.claimSpawnDispatch(effectIntentId);
  if (!claimed) throw new Error(`subagent_spawn ${effectIntentId} was already dispatched or settled.`);
  const request = await input.services.effects.readEffectRequest(effectIntentId);
  let observed: SubagentSpawnAdapterResult;
  try {
    observed = await input.adapter.spawn(request);
  } catch (error) {
    if (!(error instanceof SubagentSpawnDispatchError)) throw error;
    observed = {
      outcome: error.dispatched ? 'outcome_unknown' : 'failed',
      detail: { message: error.message, dispatched: error.dispatched }
    };
  }
  const receipt = await input.services.children.recordSpawnReceipt({
    sourceKey: requirePhaseFText(input.callbackKey, 'callbackKey'),
    attemptId,
    outcome: observed.outcome,
    ...(observed.detail === undefined ? {} : { detail: observed.detail })
  });
  return input.services.children.reconcileSpawnReceipt(receipt.effectReceiptId);
}

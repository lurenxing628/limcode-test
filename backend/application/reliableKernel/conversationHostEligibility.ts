import type { WorkEnvironmentRecord } from '../../../shared/protocol';
import type { ContentAddressedStore } from '../../reliableKernel/contentAddressedStore';
import type { ReliableDiagnosticObserver } from '../../reliableKernel/diagnosticJournal';
import { projectFolderForConversation } from '../../reliableKernel/conversationProject';
import { frozenWorkEnvironmentPolicy, readFrozenTurnAuthority } from '../../reliableKernel/frozenAuthority';
import { listAllDomainRows } from '../../reliableKernel/repositoryPagination';
import type { RuntimeDatabase } from '../../reliableKernel/runtimeDatabase';

export type ConversationHostEligibilityDecision =
  | { eligible: true }
  | { eligible: false; reason: 'project_not_open'; projectUri: string; projectName: string }
  | {
      eligible: false;
      reason: 'work_environment_unavailable';
      turnId: string;
      workEnvironmentId: string;
      /** Name and path from this window's catalog, for messages; never the internal id. */
      workEnvironmentLabel?: string;
    };

/** What a window shows: the decision, or why it could not be made (the probe failed). */
export type ConversationHostEligibilityView =
  | ConversationHostEligibilityDecision
  | { eligible: false; reason: 'probe_failed'; errorName: string; message: string };

const PROBE_FAILURE_REPORT_INTERVAL_MS = 60_000;
const PROBE_FAILURE_REPORT_ENTRIES = 1_000;

export interface ConversationHostEligibilityDependencies {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  /** `Uri.toString()` of every folder currently open in this Host, the ProjectContext identity form. */
  workspaceFolderUris(): readonly string[];
  /** This Host's work-environment catalog; workspace-folder `available` is Host-local presence. */
  workEnvironments(): Promise<readonly WorkEnvironmentRecord[]>;
  /** Frozen default work environment by Turn id (immutable once frozen), shared across probes. */
  frozenWorkEnvironmentCache?: Map<string, string | null>;
}

const FROZEN_WORK_ENVIRONMENT_CACHE_ENTRIES = 1_000;

/**
 * Decides whether this Host may take over a Conversation's background work from committed facts:
 * its primary ProjectContext folder must be open here, and every active Turn's frozen default work
 * environment must be available here (the same condition tool dispatch enforces). A Conversation
 * without a project link and without a frozen default environment has no durable placement fact,
 * so every Host remains eligible for it.
 */
export async function evaluateConversationHostEligibility(
  dependencies: ConversationHostEligibilityDependencies,
  conversationId: string
): Promise<ConversationHostEligibilityDecision> {
  const project = await projectFolderForConversation(dependencies.database, conversationId);
  if (project && !dependencies.workspaceFolderUris().includes(project.uri)) {
    return { eligible: false, reason: 'project_not_open', projectUri: project.uri, projectName: project.name };
  }
  const activeTurns = await listAllDomainRows(dependencies.database, 'Turn', {
    conversation_id: conversationId,
    status: 'active'
  });
  let environments: readonly WorkEnvironmentRecord[] | undefined;
  for (const turn of activeTurns) {
    const turnId = requireId(turn.id, 'Turn.id');
    const workEnvironmentId = await frozenDefaultWorkEnvironment(dependencies, turnId);
    if (!workEnvironmentId) continue;
    environments ??= await dependencies.workEnvironments();
    const environment = environments.find((candidate) => candidate.id === workEnvironmentId);
    if (!environment?.available) {
      const label = environment ? workEnvironmentLabel(environment) : undefined;
      return {
        eligible: false,
        reason: 'work_environment_unavailable',
        turnId,
        workEnvironmentId,
        ...(label ? { workEnvironmentLabel: label } : {})
      };
    }
  }
  return { eligible: true };
}

async function frozenDefaultWorkEnvironment(
  dependencies: ConversationHostEligibilityDependencies,
  turnId: string
): Promise<string | undefined> {
  const cache = dependencies.frozenWorkEnvironmentCache;
  const cached = cache?.get(turnId);
  if (cached !== undefined) return cached ?? undefined;
  const snapshots = await listAllDomainRows(dependencies.database, 'AuthoritySnapshot', { turn_id: turnId });
  if (snapshots.length > 1) throw new Error(`Turn ${turnId} must have at most one AuthoritySnapshot.`);
  // A Turn without its snapshot yet is still freezing; only a frozen answer is cached.
  if (snapshots.length === 0) return undefined;
  const workEnvironmentId = frozenWorkEnvironmentPolicy((await readFrozenTurnAuthority(
    dependencies.database,
    dependencies.contentStore,
    requireId(snapshots[0].id, 'AuthoritySnapshot.id'),
    turnId
  )).document)?.defaultWorkEnvironmentId ?? null;
  if (cache) {
    if (cache.size >= FROZEN_WORK_ENVIRONMENT_CACHE_ENTRIES) cache.clear();
    cache.set(turnId, workEnvironmentId);
  }
  return workEnvironmentId ?? undefined;
}

function workEnvironmentLabel(environment: WorkEnvironmentRecord): string | undefined {
  const name = environment.name?.trim();
  const where = environment.displayPath ?? environment.rootPath ?? environment.uri;
  if (!name) return where || undefined;
  return where && where !== name ? `${name}（${where}）` : name;
}

/**
 * Counts every eligibility decision in the diagnostic rollup by reason. A probe failure is also
 * recorded for its Conversation, at most once a minute each, and rethrown so the owner manager
 * treats it as unknown (never as eligible).
 */
export function createDiagnosedConversationHostEligibility(
  evaluate: (conversationId: string) => Promise<ConversationHostEligibilityDecision>,
  diagnostics: ReliableDiagnosticObserver | undefined,
  now: () => number = Date.now
): (conversationId: string) => Promise<ConversationHostEligibilityDecision> {
  const lastFailureReport = new Map<string, number>();
  const count = (reasonCode: string): void => diagnostics?.aggregate?.({
    eventKind: 'eligibility.decision',
    scopeKind: 'runtime',
    dimensions: { reasonCode }
  });
  return async (conversationId) => {
    try {
      const decision = await evaluate(conversationId);
      count(decision.eligible ? 'eligible' : decision.reason);
      return decision;
    } catch (error) {
      count('probe_failed');
      const at = now();
      const last = lastFailureReport.get(conversationId);
      if (last === undefined || at - last >= PROBE_FAILURE_REPORT_INTERVAL_MS) {
        if (lastFailureReport.size >= PROBE_FAILURE_REPORT_ENTRIES) lastFailureReport.clear();
        lastFailureReport.set(conversationId, at);
        diagnostics?.observe({
          eventKind: 'eligibility.probe_failed',
          scopeKind: 'conversation',
          scopeId: conversationId,
          metadata: {
            conversationId,
            reasonCode: 'probe_failed',
            errorName: error instanceof Error ? error.name : 'unknown'
          }
        });
      }
      throw error;
    }
  };
}

export async function viewConversationHostEligibility(
  probe: (conversationId: string) => Promise<ConversationHostEligibilityDecision>,
  conversationId: string
): Promise<ConversationHostEligibilityView> {
  try {
    return await probe(conversationId);
  } catch (error) {
    return {
      eligible: false,
      reason: 'probe_failed',
      errorName: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/** The window-facing sentence for work this window will not execute. */
export function conversationHostIneligibleMessage(
  view: Exclude<ConversationHostEligibilityView, { eligible: true }>
): string {
  if (view.reason === 'project_not_open') return `这个对话属于项目“${view.projectName}”，请在打开该项目的窗口中继续。`;
  if (view.reason === 'work_environment_unavailable') {
    return view.workEnvironmentLabel
      ? `这个对话正在工作环境“${view.workEnvironmentLabel}”中运行，当前窗口不能使用它，请在有它的窗口中继续。`
      : '这个对话正在一个当前窗口没有的工作环境中运行，请在有它的窗口中继续。';
  }
  return `无法确认当前窗口能否继续这个对话（${view.message}），因此不会在这里执行。`;
}

/** A stop whose Turn still has a tool running in another window that is alive or unverifiable. */
export const STOP_WAITS_FOR_EXECUTING_WINDOW_MESSAGE =
  '停止请求已记录。这个对话的工具仍在另一个窗口中执行，请到该窗口查看停止结果。';

/** An answer or approval recorded in a window that does not serve the Conversation. */
export function conversationAnswerRecordedMessage(
  view: Exclude<ConversationHostEligibilityView, { eligible: true }>
): string {
  if (view.reason === 'project_not_open') return `回答已记录，将在打开项目“${view.projectName}”的窗口中继续执行。`;
  if (view.reason === 'work_environment_unavailable') {
    return view.workEnvironmentLabel
      ? `回答已记录，将在有工作环境“${view.workEnvironmentLabel}”的窗口中继续执行。`
      : '回答已记录，将在有该对话工作环境的窗口中继续执行。';
  }
  return `回答已记录；无法确认当前窗口能否继续这个对话（${view.message}），因此不会在这里继续执行。`;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

import type { WorkEnvironmentRecord } from '../../../shared/protocol';
import { workEnvironmentIdFromUri } from '../../../shared/workEnvironmentCatalog';
import type { ContentAddressedStore, ContentObjectMetadata } from '../../reliableKernel/contentAddressedStore';
import type { ReliableDiagnosticObserver } from '../../reliableKernel/diagnosticJournal';
import { projectFolderForConversation } from '../../reliableKernel/conversationProject';
import { frozenWorkEnvironmentPolicy, readFrozenTurnAuthority } from '../../reliableKernel/frozenAuthority';
import { normalizePlainJson } from '../../reliableKernel/plainJson';
import { listAllDomainRows } from '../../reliableKernel/repositoryPagination';
import type { RuntimeDatabase } from '../../reliableKernel/runtimeDatabase';
import type { TurnWorkEnvironmentPreview } from '../../reliableKernel/turnControlPlane';

export type ConversationHostEligibilityDecision =
  | { eligible: true }
  | { eligible: false; reason: 'project_not_open'; projectUri: string; projectName: string }
  | {
      eligible: false;
      reason: 'work_environment_unavailable';
      /** The active Turn (or, for queued input, the queued TurnIntent) that froze it. */
      turnId?: string;
      intentId?: string;
      workEnvironmentId: string;
      /** Name and path from this window's catalog, for messages; never the internal id. */
      workEnvironmentLabel?: string;
    }
  | { eligible: false; reason: 'next_work_environment_unavailable'; message: string };

/** What a window shows: the decision, or why it could not be made (the probe failed). */
export type ConversationHostEligibilityView =
  | ConversationHostEligibilityDecision
  | { eligible: false; reason: 'probe_failed'; errorName: string; message: string };

const PROBE_FAILURE_REPORT_INTERVAL_MS = 60_000;
const PROBE_FAILURE_REPORT_ENTRIES = 1_000;

/** What the next Turn would be: its executor (a per-message Agent) or the Turn whose authority it inherits. */
export interface ConversationNextTurnOptions {
  /** The Agent the new input names; the Conversation's default Agent otherwise. */
  executorAgentId?: string;
  /** A runtime continuation inherits this Turn's frozen authority, work environment included. */
  inheritsFromTurnId?: string;
}

export interface ConversationHostEligibilityDependencies {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  /** `Uri.toString()` of every folder currently open in this Host, the ProjectContext identity form. */
  workspaceFolderUris(): readonly string[];
  /** This Host's work-environment catalog; workspace-folder `available` is Host-local presence. */
  workEnvironments(): Promise<readonly WorkEnvironmentRecord[]>;
  /** Frozen default work environment by Turn or queued TurnIntent id (immutable once frozen), shared across probes. */
  frozenWorkEnvironmentCache?: Map<string, string | null>;
  /**
   * The work environment the next Turn would freeze here, resolved like compile() (explicit choice,
   * inherited boundary, project, scoped policy default); undefined when it cannot be previewed.
   */
  nextTurnWorkEnvironment?(
    conversationId: string,
    options?: Pick<ConversationNextTurnOptions, 'executorAgentId'>
  ): Promise<TurnWorkEnvironmentPreview | undefined>;
}

const FROZEN_WORK_ENVIRONMENT_CACHE_ENTRIES = 1_000;

/** One piece of execution work and the default work environment its authority froze. */
interface PlacedWork {
  turnId?: string;
  intentId?: string;
  workEnvironmentId: string | undefined;
}

/**
 * Decides whether this Host may take over a Conversation's background work from committed facts.
 * The work is every active Turn and every queued TurnIntent; each froze its authority, work
 * environment included, when it was created. Each must be placeable here: a frozen work environment
 * other than the project's own (one the user chose, for example after the project folder moved)
 * only needs to be available here; the project's own work environment, or none, also needs the
 * project folder open here. An idle Conversation is served where its project folder is open, or,
 * when that folder is not open here, where its next Turn could start (the work environment chosen
 * for it is available here). A Conversation without a project link and without frozen work
 * environments has no durable placement fact, so every Host remains eligible for it.
 */
export async function evaluateConversationHostEligibility(
  dependencies: ConversationHostEligibilityDependencies,
  conversationId: string
): Promise<ConversationHostEligibilityDecision> {
  const project = await projectFolderForConversation(dependencies.database, conversationId);
  const work = await frozenConversationWork(dependencies, conversationId);
  if (work.length > 0) return placementEligibility(dependencies, project, work);
  if (!project || dependencies.workspaceFolderUris().includes(project.uri)) return { eligible: true };
  const next = await dependencies.nextTurnWorkEnvironment?.(conversationId);
  if (next?.workEnvironmentId !== undefined && !next.error) return { eligible: true };
  return { eligible: false, reason: 'project_not_open', projectUri: project.uri, projectName: project.name };
}

export interface ConversationEntryEligibilityDependencies extends ConversationHostEligibilityDependencies {
  /** The work environment the next Turn would freeze here; undefined when it cannot be previewed. */
  nextTurnWorkEnvironment(
    conversationId: string,
    options?: Pick<ConversationNextTurnOptions, 'executorAgentId'>
  ): Promise<TurnWorkEnvironmentPreview | undefined>;
}

/**
 * Whether new input, retry, edit-and-run, compression or a runtime continuation may start a Turn in
 * this window, judged by the work environment that Turn will freeze. While the Conversation has an
 * active Turn or queued input, that work must also be placeable here (evaluateConversationHostEligibility).
 * A runtime continuation inherits its source Turn's frozen work environment; any other new Turn
 * freezes what compile() resolves now, including a work environment the user chose in this window,
 * even when the project folder moved.
 */
export async function evaluateConversationEntryEligibility(
  dependencies: ConversationEntryEligibilityDependencies,
  conversationId: string,
  options: ConversationNextTurnOptions = {}
): Promise<ConversationHostEligibilityDecision> {
  const project = await projectFolderForConversation(dependencies.database, conversationId);
  const work = await frozenConversationWork(dependencies, conversationId);
  if (options.inheritsFromTurnId) {
    const turnId = options.inheritsFromTurnId;
    return placementEligibility(dependencies, project, [
      ...work,
      { turnId, workEnvironmentId: await frozenDefaultWorkEnvironment(dependencies, turnId) }
    ]);
  }
  if (work.length > 0) return placementEligibility(dependencies, project, work);
  const next = await dependencies.nextTurnWorkEnvironment(conversationId, {
    ...(options.executorAgentId ? { executorAgentId: options.executorAgentId } : {})
  });
  if (!next) return evaluateConversationHostEligibility(dependencies, conversationId);
  if (next.error) return { eligible: false, reason: 'next_work_environment_unavailable', message: next.error };
  return { eligible: true };
}

/** Active Turns and queued TurnIntents with the default work environment each froze. */
async function frozenConversationWork(
  dependencies: ConversationHostEligibilityDependencies,
  conversationId: string
): Promise<PlacedWork[]> {
  const [activeTurns, queuedIntents] = await Promise.all([
    listAllDomainRows(dependencies.database, 'Turn', { conversation_id: conversationId, status: 'active' }),
    listAllDomainRows(dependencies.database, 'TurnIntent', { conversation_id: conversationId, state: 'queued', turn_id: null })
  ]);
  const work: PlacedWork[] = [];
  for (const turn of activeTurns) {
    const turnId = requireId(turn.id, 'Turn.id');
    work.push({ turnId, workEnvironmentId: await frozenDefaultWorkEnvironment(dependencies, turnId) });
  }
  for (const intent of queuedIntents) {
    const intentId = requireId(intent.id, 'TurnIntent.id');
    work.push({ intentId, workEnvironmentId: await queuedIntentWorkEnvironment(dependencies, intentId) });
  }
  return work;
}

async function placementEligibility(
  dependencies: ConversationHostEligibilityDependencies,
  project: { uri: string; name: string } | undefined,
  work: readonly PlacedWork[]
): Promise<ConversationHostEligibilityDecision> {
  if (project && !dependencies.workspaceFolderUris().includes(project.uri)) {
    const projectEnvironmentId = workEnvironmentIdFromUri(project.uri);
    if (work.some((item) => item.workEnvironmentId === undefined || item.workEnvironmentId === projectEnvironmentId)) {
      return { eligible: false, reason: 'project_not_open', projectUri: project.uri, projectName: project.name };
    }
  }
  let environments: readonly WorkEnvironmentRecord[] | undefined;
  for (const { turnId, intentId, workEnvironmentId } of work) {
    if (!workEnvironmentId) continue;
    environments ??= await dependencies.workEnvironments();
    const environment = environments.find((candidate) => candidate.id === workEnvironmentId);
    if (!environment?.available) {
      const label = environment ? workEnvironmentLabel(environment) : undefined;
      return {
        eligible: false,
        reason: 'work_environment_unavailable',
        ...(turnId ? { turnId } : {}),
        ...(intentId ? { intentId } : {}),
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
  rememberFrozen(cache, turnId, workEnvironmentId);
  return workEnvironmentId ?? undefined;
}

/** A queued TurnIntent froze its authority when it was queued (TurnIntentAuthorityRevision). */
async function queuedIntentWorkEnvironment(
  dependencies: ConversationHostEligibilityDependencies,
  intentId: string
): Promise<string | undefined> {
  const cacheKey = `intent:${intentId}`;
  const cache = dependencies.frozenWorkEnvironmentCache;
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) return cached ?? undefined;
  const revisions = await listAllDomainRows(dependencies.database, 'TurnIntentAuthorityRevision', { intent_id: intentId });
  if (revisions.length > 1) throw new Error(`TurnIntent ${intentId} must have at most one frozen authority.`);
  if (revisions.length === 0) return undefined;
  const objects = await listAllDomainRows(dependencies.database, 'ContentObject', {
    id: requireId(revisions[0].authority_object_id, 'TurnIntentAuthorityRevision.authority_object_id')
  });
  if (objects.length !== 1) throw new Error(`TurnIntent ${intentId} frozen authority content is missing.`);
  let document: unknown;
  try {
    document = JSON.parse((await dependencies.contentStore.read(objects[0] as ContentObjectMetadata)).toString('utf8'));
  } catch (error) {
    throw new Error(`TurnIntent ${intentId} frozen authority is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workEnvironmentId = frozenWorkEnvironmentPolicy(normalizePlainJson(document, `TurnIntent ${intentId} authority`))
    ?.defaultWorkEnvironmentId ?? null;
  rememberFrozen(cache, cacheKey, workEnvironmentId);
  return workEnvironmentId ?? undefined;
}

function rememberFrozen(cache: Map<string, string | null> | undefined, key: string, value: string | null): void {
  if (!cache) return;
  if (cache.size >= FROZEN_WORK_ENVIRONMENT_CACHE_ENTRIES) cache.clear();
  cache.set(key, value);
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
  if (view.reason === 'next_work_environment_unavailable') {
    return `${view.message}也可以在本窗口手动选择工作环境后继续。`;
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
  if (view.reason === 'next_work_environment_unavailable') return `回答已记录。${view.message}`;
  return `回答已记录；无法确认当前窗口能否继续这个对话（${view.message}），因此不会在这里继续执行。`;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

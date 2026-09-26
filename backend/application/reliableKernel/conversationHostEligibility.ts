import type { WorkEnvironmentRecord } from '../../../shared/protocol';
import type { ContentAddressedStore } from '../../reliableKernel/contentAddressedStore';
import { projectFolderForConversation } from '../../reliableKernel/conversationProject';
import { frozenWorkEnvironmentPolicy, readFrozenTurnAuthority } from '../../reliableKernel/frozenAuthority';
import { listAllDomainRows } from '../../reliableKernel/repositoryPagination';
import type { RuntimeDatabase } from '../../reliableKernel/runtimeDatabase';

export type ConversationHostEligibilityDecision =
  | { eligible: true }
  | { eligible: false; reason: 'project_not_open'; projectUri: string; projectName: string }
  | { eligible: false; reason: 'work_environment_unavailable'; turnId: string; workEnvironmentId: string };

export interface ConversationHostEligibilityDependencies {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  /** `Uri.toString()` of every folder currently open in this Host, the ProjectContext identity form. */
  workspaceFolderUris(): readonly string[];
  /** This Host's work-environment catalog; workspace-folder `available` is Host-local presence. */
  workEnvironments(): Promise<readonly WorkEnvironmentRecord[]>;
}

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
    const snapshots = await listAllDomainRows(dependencies.database, 'AuthoritySnapshot', { turn_id: turnId });
    if (snapshots.length === 0) continue;
    if (snapshots.length > 1) throw new Error(`Turn ${turnId} must have at most one AuthoritySnapshot.`);
    const frozen = await readFrozenTurnAuthority(
      dependencies.database,
      dependencies.contentStore,
      requireId(snapshots[0].id, 'AuthoritySnapshot.id'),
      turnId
    );
    const workEnvironmentId = frozenWorkEnvironmentPolicy(frozen.document)?.defaultWorkEnvironmentId;
    if (!workEnvironmentId) continue;
    environments ??= await dependencies.workEnvironments();
    if (!environments.some((environment) => environment.id === workEnvironmentId && environment.available)) {
      return { eligible: false, reason: 'work_environment_unavailable', turnId, workEnvironmentId };
    }
  }
  return { eligible: true };
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

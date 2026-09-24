import type { WorkEnvironmentRecord } from '../../shared/protocol';

export interface FrozenWorkEnvironmentBoundaryPolicy {
  /** Controls whether the model may switch environments; it does not disable the local path boundary. */
  enabled: boolean;
  allowedWorkEnvironmentIds: readonly string[];
  defaultWorkEnvironmentId: string | null;
}

export interface ResolvedWorkEnvironmentBoundary {
  switchingEnabled: boolean;
  allowed: WorkEnvironmentRecord[];
  active?: WorkEnvironmentRecord;
}

/**
 * Interprets a frozen WorkEnvironmentPolicy without weakening its path boundary.
 *
 * `enabled=false` means “do not expose environment switching”; settings UI labels this mode as
 * “仅作为本地路径边界”. File and process tools must therefore keep using the frozen allowed/default
 * environments instead of silently dropping every root.
 */
export function resolveFrozenWorkEnvironmentBoundary(
  policy: FrozenWorkEnvironmentBoundaryPolicy,
  records: readonly WorkEnvironmentRecord[]
): ResolvedWorkEnvironmentBoundary {
  const byId = new Map(records.map((environment) => [environment.id, environment]));
  const allowed = policy.allowedWorkEnvironmentIds
    .map((id) => byId.get(id))
    .filter((environment): environment is WorkEnvironmentRecord => !!environment && environment.available);
  const active = policy.defaultWorkEnvironmentId
    ? allowed.find((environment) => environment.id === policy.defaultWorkEnvironmentId)
    : undefined;
  if (policy.defaultWorkEnvironmentId && !active) {
    throw new Error(`本回合冻结的工作环境已不可用：${policy.defaultWorkEnvironmentId}，请重新选择后开始新回合。`);
  }
  return {
    switchingEnabled: policy.enabled,
    allowed,
    ...(active ? { active } : {})
  };
}

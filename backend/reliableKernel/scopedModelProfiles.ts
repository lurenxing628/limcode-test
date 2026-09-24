import type { ConfigScopeKind, ModelProfileRecord, ModelProfileScopeLinkRecord } from '../../shared/protocol';
import type { StoragePaths } from '../capabilities/vscodeStorage/paths';
import { loadRecordStore, loadRecordStoreByIds } from '../capabilities/vscodeStorage/recordStore';

/**
 * 原 DeepSeek 渠道并入 OpenAI 兼容后，会话、Agent 上保存的模型选择按迁移后的渠道类型读取，
 * 否则“渠道或模型已改变”之类的身份检查会把它们当成另一个渠道。
 */
export function canonicalModelProfile(profile: ModelProfileRecord): ModelProfileRecord {
  return (profile.provider as unknown) === 'deepseek' ? { ...profile, provider: 'openai-compatible' } : profile;
}

/** Read current links, then only the profiles referenced by the requested scopes. No TTL cache. */
export async function loadScopedModelProfiles(
  paths: StoragePaths,
  scopes: readonly { scopeKind: ConfigScopeKind; scopeId?: string }[]
): Promise<{ modelProfiles: ModelProfileRecord[]; modelProfileScopeLinks: ModelProfileScopeLinkRecord[] }> {
  const links = await loadRecordStore<ModelProfileScopeLinkRecord, 'link'>(
    paths.modelProfileScopeLinksRootUri, paths.modelProfileScopeLinksIndexUri, 'link'
  );
  const modelProfileScopeLinks = (links ?? []).filter(link => link.role === 'active' && scopes.some(scope =>
    link.scopeKind === scope.scopeKind && (scope.scopeKind === 'global' || link.scopeId === scope.scopeId)
  ));
  const modelProfiles = modelProfileScopeLinks.length ? await loadRecordStoreByIds<ModelProfileRecord, 'modelProfile'>(
    paths.modelProfilesRootUri, paths.modelProfilesIndexUri, 'modelProfile',
    modelProfileScopeLinks.map(link => link.modelProfileId)
  ) : [];
  return { modelProfiles: modelProfiles.map(canonicalModelProfile), modelProfileScopeLinks };
}

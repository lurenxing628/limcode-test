import type { ConfigScopeKind, ModelProfileRecord, ModelProfileScopeLinkRecord } from '../../shared/protocol';
import type { StoragePaths } from '../capabilities/vscodeStorage/paths';
import { loadRecordStore, loadRecordStoreByIds } from '../capabilities/vscodeStorage/recordStore';

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
  return { modelProfiles, modelProfileScopeLinks };
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(p) { this.scheme = 'file'; this.authority = ''; this.fsPath = path.resolve(p); this.path = this.fsPath; }
  static file(p) { return new Uri(p); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? { Uri } : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const { createVscodeStoragePaths } = require('../../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const { VscodeConfigurationAuthority } = require('../../dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js');
const { workEnvironmentIdFromUri } = require('../../dist/extension/shared/workEnvironmentCatalog.js');
const request = { conversationId: 'conversation', executorAgentId: 'agent' };

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-preview-reads-'));
  const paths = createVscodeStoragePaths(Uri.file(root));
  const authority = new VscodeConfigurationAuthority(() => paths);
  const store = async (name, key, records) => {
    const dir = paths[`${name}RootUri`].fsPath;
    await fs.mkdir(path.join(dir, 'records'), { recursive: true });
    await Promise.all(records.map(record => fs.writeFile(path.join(dir, 'records', `${record.id}.json`), JSON.stringify({ schemaVersion: 1, savedAt: '', [key]: record }))));
    await fs.writeFile(paths[`${name}IndexUri`].fsPath, JSON.stringify({ schemaVersion: 1, savedAt: '', records: records.map(record => ({ id: record.id, file: `records/${record.id}.json`, updatedAt: '2026-09-30T00:00:00.000Z' })) }));
  };
  try { await run({ root, paths, authority, store }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const environment = id => ({ id, kind: 'remoteServer', source: 'manual', name: id, host: `${id}.test`, available: true, createdAt: 1, updatedAt: 1 });
const policy = (id, defaultId = 'a') => ({ id, enabled: true, allowedWorkEnvironmentIds: ['a', 'b'], defaultWorkEnvironmentId: defaultId, createdAt: 1, updatedAt: 1 });
const link = (scopeKind, policyId, scopeId) => ({ id: `link-${scopeKind}`, scopeKind, ...(scopeId ? { scopeId } : {}), workEnvironmentPolicyId: policyId, role: 'active', createdAt: 1, updatedAt: 1 });

async function measure(operation) {
  const originalRead = fs.readFile;
  const reads = [];
  fs.readFile = (...args) => { reads.push(String(args[0])); return originalRead(...args); };
  const start = performance.now();
  try { return { value: await operation(), reads, ms: performance.now() - start }; }
  finally { fs.readFile = originalRead; }
}

test('preview reads directory catalogs and scoped policy records only; full compile loader stays fresh', async () => fixture(async ({ authority, store }) => {
  await store('workEnvironments', 'workEnvironment', [environment('a'), environment('b')]);
  await store('workEnvironmentPolicyScopeLinks', 'link', [link('global', 'global')]);
  await store('workEnvironmentPolicies', 'policy', [policy('global'), ...Array.from({ length: 60 }, (_, i) => policy(`unrelated-${i}`))]);
  await store('modelProfiles', 'modelProfile', Array.from({ length: 60 }, (_, i) => ({ id: `model-${i}` })));
  const before = await measure(() => authority.loadRecords()); // the previous preview's exact loader
  const after = await measure(() => authority.previewWorkEnvironment(request));
  assert.equal(after.value.workEnvironmentId, 'a');
  assert.equal(after.reads.length, 9);
  assert.ok(before.reads.length > after.reads.length + 120);
  assert.ok(after.reads.every(file => !file.includes('model-profiles') && !file.includes('unrelated-')));
  console.log(`WORK_ENVIRONMENT_PREVIEW_IO before=${before.reads.length} after=${after.reads.length} beforeMs=${before.ms.toFixed(2)} afterMs=${after.ms.toFixed(2)}`);
  await store('workEnvironmentPolicies', 'policy', [policy('global', 'b')]);
  assert.equal((await authority.previewWorkEnvironment(request)).workEnvironmentId, 'b', 'peer edits must be read again, without TTL reuse');
}));

test('preview preserves conversation > workflow > agent > global policy defaults and latest selection', async () => fixture(async ({ authority, store }) => {
  await store('workEnvironments', 'workEnvironment', [environment('a'), environment('b')]);
  await store('workEnvironmentPolicies', 'policy', ['global', 'agent', 'workflow', 'conversation'].map((id, i) => policy(id, i % 2 ? 'b' : 'a')));
  await store('conversationWorkflowSelections', 'selection', [{ id: 'workflow-choice', conversationId: 'conversation', workflowId: 'workflow', scopeKind: 'workflow', role: 'active', createdAt: 1, updatedAt: 1 }]);
  const links = [link('global', 'global'), link('agent', 'agent', 'agent'), link('workflow', 'workflow', 'workflow'), link('conversation', 'conversation', 'conversation')];
  for (let count = links.length; count > 0; count--) {
    await store('workEnvironmentPolicyScopeLinks', 'link', links.slice(0, count));
    const result = await authority.previewWorkEnvironment(request);
    assert.equal(result.policy.id, links[count - 1].workEnvironmentPolicyId);
    assert.equal(result.workEnvironmentId, count % 2 ? 'a' : 'b');
  }
  await store('workEnvironmentPolicyScopeLinks', 'link', [
    link('global', 'global'), link('conversation', 'conversation', 'conversation'),
    { ...link('conversation', 'deleted-policy', 'conversation'), id: 'latest-dangling', updatedAt: 9 }
  ]);
  assert.equal((await authority.previewWorkEnvironment(request)).policy.id, 'global', 'latest dangling scope link falls to lower scope rather than resurrecting an older link');
  await store('conversationWorkEnvironmentLinks', 'link', [
    { id: 'old', conversationId: 'conversation', role: 'active', workEnvironmentId: 'a', createdAt: 1, updatedAt: 1 },
    { id: 'new', conversationId: 'conversation', role: 'active', workEnvironmentId: 'b', createdAt: 1, updatedAt: 2 }
  ]);
  assert.equal((await authority.previewWorkEnvironment(request)).workEnvironmentId, 'b');
  const bounded = await authority.previewWorkEnvironment({ ...request, inheritedWorkEnvironmentPolicy: { allowedWorkEnvironmentIds: ['a'], defaultWorkEnvironmentId: 'a' } });
  assert.match(bounded.error, /子 Agent/);
  await store('conversationWorkEnvironmentLinks', 'link', []);
  assert.equal((await authority.previewWorkEnvironment({ ...request, inheritedWorkEnvironmentPolicy: { allowedWorkEnvironmentIds: ['b'], defaultWorkEnvironmentId: 'b' } })).workEnvironmentId, 'b');
}));

test('missing catalogs remain empty, host-local project projection is preserved, relevant read failures reject', async () => fixture(async ({ root, paths, authority, store }) => {
  assert.deepEqual(await authority.previewWorkEnvironment(request), { policy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null } });
  const uri = Uri.file(path.join(root, 'folder')).toString();
  const local = new VscodeConfigurationAuthority(() => paths, undefined, [{ uri, rootPath: path.join(root, 'folder'), name: 'folder', index: 0 }]);
  assert.equal((await local.previewWorkEnvironment({ ...request, workspace: { uri } })).workEnvironmentId, workEnvironmentIdFromUri(uri));
  const localId = workEnvironmentIdFromUri(uri);
  await store('workEnvironments', 'workEnvironment', [environment('a')]);
  await store('workEnvironmentPolicies', 'policy', [{ ...policy('global'), allowedWorkEnvironmentIds: [localId, 'a'] }]);
  await store('workEnvironmentPolicyScopeLinks', 'link', [link('global', 'global')]);
  assert.equal((await local.previewWorkEnvironment({ ...request, workspace: { uri } })).workEnvironmentId, localId, 'project precedes policy default');
  assert.equal((await local.previewWorkEnvironment({ ...request, workspace: { uri }, inheritedWorkEnvironmentPolicy: { allowedWorkEnvironmentIds: [localId, 'a'], defaultWorkEnvironmentId: 'a' } })).workEnvironmentId, 'a', 'inherited default precedes project');

  await store('workEnvironmentPolicyScopeLinks', 'link', [link('global', 'missing')]);
  assert.equal((await authority.previewWorkEnvironment(request)).policy.id, null, 'missing referenced policy keeps existing fallback semantics');
  await fs.writeFile(paths.workEnvironmentPolicyScopeLinksIndexUri.fsPath, '{');
  await assert.rejects(authority.previewWorkEnvironment(request), SyntaxError);
  await store('workEnvironmentPolicyScopeLinks', 'link', [link('global', 'global')]);
  await store('workEnvironmentPolicies', 'policy', [policy('global')]);
  const originalRead = fs.readFile;
  fs.readFile = async (...args) => {
    if (String(args[0]).endsWith('global.json')) throw Object.assign(new Error('permission denied fixture'), { code: 'EACCES' });
    return originalRead(...args);
  };
  try { await assert.rejects(authority.previewWorkEnvironment(request), /permission denied fixture/); }
  finally { fs.readFile = originalRead; }
}));

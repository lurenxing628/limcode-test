// Configuration reads while the settings directory does not exist (a new data directory, or the
// mount point of an unmounted data drive) create nothing: every section, file-backed or record
// store, answers with its defaults in memory. A missing file or store and one holding exactly the
// defaults are the same state, so a page's first save is not rejected because another read wrote
// the defaults meanwhile; a real change by someone else still is. Runs against the compiled
// extension (LIMCODE_TEST_EXTENSION_ROOT or dist).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function load(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
after(() => { Module._load = originalLoad; });
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const { createVscodeStoragePaths } = require(path.join(compiled, 'backend/capabilities/vscodeStorage/paths.js'));
const { createDefaultLlmProviderConfig } = require(path.join(compiled, 'backend/capabilities/vscodeStorage/llmProviderConfigs.js'));
const { VscodeConfigurationAuthority } = require(path.join(compiled, 'backend/reliableKernel/vscodeConfigurationAuthority.js'));

const SECTIONS = ['llm', 'llmProviderConfigs', 'llmCompressionConfigs', 'llmCompression', 'mcpServers', 'network', 'appearance', 'attachments', 'checkpointMaintenance', 'debugCapture'];

async function tree(root) {
  const out = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      out.push(path.relative(root, file) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await visit(file);
    }
  };
  await visit(root);
  return out;
}

async function base(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-missing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const authorityAt = (root) => new VscodeConfigurationAuthority(() => createVscodeStoragePaths(vscode.Uri.file(root)));

for (const section of [...SECTIONS, 'configurationClientState']) {
  test(`reloc3 #3 数据目录不存在（外置盘没挂上）时读 ${section}：只在内存里给默认值，不建任何目录或文件`, async (t) => {
    const directory = await base(t);
    const root = path.join(directory, 'mnt', 'usb', 'LimCode');
    const authority = authorityAt(root);
    const loaded = section === 'configurationClientState' ? await authority.configurationClientState() : await authority.loadGlobalSettings(section);
    assert.ok(loaded);
    if (section === 'llmProviderConfigs') assert.equal(loaded.settings.configs.length, 1, '默认渠道只在内存里');
    assert.deepEqual(await tree(directory), []);
  });
}

for (const layout of ['数据目录已存在、settings/ 还没有', '数据目录还不存在']) {
  test(`reloc3 #5 新目录首次配置（${layout}）：先读 llm 和渠道，保存第一个渠道（它会写出默认 llm.json），再用读到的修订号设为当前渠道`, async (t) => {
    const root = path.join(await base(t), 'globalStorage');
    if (layout.startsWith('数据目录已存在')) await fs.mkdir(path.join(root, '.limcode-runtime'), { recursive: true });
    const authority = authorityAt(root);
    const llm = await authority.loadGlobalSettings('llm');
    const providers = await authority.loadGlobalSettings('llmProviderConfigs');
    const provider = { ...createDefaultLlmProviderConfig({ name: 'first' }), id: 'first-provider', model: 'o3', models: [{ id: 'o3', name: 'o3' }], modelConfigs: [] };
    await authority.saveGlobalSettings('llmProviderConfigs', { configs: [provider] }, providers.revision);
    const saved = await authority.saveGlobalSettings('llm', { activeProviderConfigId: provider.id }, llm.revision);
    assert.equal(saved.settings.activeProviderConfigId, provider.id);
    assert.equal((await authority.loadGlobalSettings('llm')).settings.activeProviderConfigId, provider.id);
  });
}

test('reloc3 #5 文件型设置：页面在 settings/ 还没有时读到默认值；之后别处建出目录、另一次读取写出默认文件；页面第一次保存照常成功；别人真改过时仍报冲突', async (t) => {
  const root = path.join(await base(t), 'globalStorage');
  await fs.mkdir(path.join(root, '.limcode-runtime'), { recursive: true });
  const authority = authorityAt(root);
  const pageA = await authority.loadGlobalSettings('appearance');
  const network = await authority.loadGlobalSettings('network');
  await authority.saveGlobalSettings('network', { userAgent: 'Client/1' }, network.revision);
  const other = await authority.loadGlobalSettings('appearance');
  assert.ok(await fs.stat(other.filePath), '前提：另一次读取写出了默认文件');
  const saved = await authority.saveGlobalSettings('appearance', { ...pageA.settings, streamingTextWaiting: '等一下' }, pageA.revision);
  assert.equal(saved.settings.streamingTextWaiting, '等一下');
  // A real change by someone else is still a conflict.
  const stale = await authorityAt(path.join(await base(t), 'fresh')).loadGlobalSettings('appearance');
  const freshRoot = path.dirname(path.dirname(stale.filePath));
  const writer = authorityAt(freshRoot);
  await fs.mkdir(path.join(freshRoot, 'settings'), { recursive: true });
  const current = await writer.loadGlobalSettings('appearance');
  await writer.saveGlobalSettings('appearance', { ...current.settings, streamingTextWaiting: '别人改的' }, current.revision);
  await assert.rejects(writer.saveGlobalSettings('appearance', { ...stale.settings, streamingTextWaiting: '旧页面' }, stale.revision),
    (error) => error?.settingsRevisionConflict === true);
});

test('reloc3 #5 记录存储型设置：页面在 settings/ 还没有时读到默认渠道和空的 MCP 列表；之后另一次读取写出默认内容；页面第一次保存照常成功；别人真改过时仍报冲突', async (t) => {
  const root = path.join(await base(t), 'globalStorage');
  await fs.mkdir(path.join(root, '.limcode-runtime'), { recursive: true });
  const authority = authorityAt(root);
  const providersA = await authority.loadGlobalSettings('llmProviderConfigs');
  const mcpA = await authority.loadGlobalSettings('mcpServers');
  const compressionA = await authority.loadGlobalSettings('llmCompressionConfigs');
  const network = await authority.loadGlobalSettings('network');
  await authority.saveGlobalSettings('network', { userAgent: 'Client/1' }, network.revision);
  // Another reader now finds settings/ and materializes the same stable default channel identity.
  const providersB = await authority.loadGlobalSettings('llmProviderConfigs');
  await authority.loadGlobalSettings('mcpServers');
  await authority.loadGlobalSettings('llmCompressionConfigs');
  assert.equal(providersB.settings.configs[0].id, providersA.settings.configs[0].id, '默认渠道写入后保留首次读取的稳定 id');
  const edited = { ...providersA.settings.configs[0], name: '我的渠道', apiKey: 'sk-a' };
  const savedProviders = await authority.saveGlobalSettings('llmProviderConfigs', { configs: [edited] }, providersA.revision);
  assert.deepEqual(savedProviders.settings.configs.map((config) => config.name), ['我的渠道']);
  const server = { id: 'server-a', name: 'A', transport: { kind: 'stdio', command: 'a' }, enabled: true, createdAt: 1, updatedAt: 1 };
  const savedMcp = await authority.saveGlobalSettings('mcpServers', { servers: [server] }, mcpA.revision);
  assert.deepEqual(savedMcp.settings.servers.map((entry) => entry.id), ['server-a']);
  const renamed = { ...compressionA.settings.configs[0], name: '我的压缩' };
  const savedCompression = await authority.saveGlobalSettings('llmCompressionConfigs', { configs: [renamed] }, compressionA.revision);
  assert.deepEqual(savedCompression.settings.configs.map((config) => config.name), ['我的压缩']);
  // Someone really changed the store after this page read it as missing: a conflict.
  const lateRoot = path.join(await base(t), 'late');
  const late = authorityAt(lateRoot);
  const stale = await late.loadGlobalSettings('mcpServers');
  await fs.mkdir(path.join(lateRoot, 'settings'), { recursive: true });
  const fresh = await late.loadGlobalSettings('mcpServers');
  await late.saveGlobalSettings('mcpServers', { servers: [server] }, fresh.revision);
  await assert.rejects(late.saveGlobalSettings('mcpServers', { servers: [] }, stale.revision), (error) => error?.settingsRevisionConflict === true);
});

function createVscodeStub() {
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  class Uri {
    constructor(fsPath) {
      this.scheme = 'file';
      this.fsPath = path.resolve(fsPath);
      this.path = this.fsPath.split(path.sep).join('/');
    }
    static file(filePath) { return new Uri(filePath); }
    static joinPath(base, ...segments) { return new Uri(path.join(base.fsPath, ...segments)); }
    toString() { return `file://${this.path}`; }
  }
  return {
    Uri,
    FileType,
    workspace: {
      fs: {
        async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
        async readFile(uri) { return fs.readFile(uri.fsPath); },
        async writeFile(uri, bytes) {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, bytes);
        },
        async readDirectory(uri) {
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown]);
        },
        async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
        async stat(uri) {
          const stat = await fs.stat(uri.fsPath);
          return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
        }
      }
    }
  };
}

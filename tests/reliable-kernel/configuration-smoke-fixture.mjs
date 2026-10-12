import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const extensionRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const compiled = file => require(path.join(extensionRoot, file));

export class Uri {
  constructor(value) {
    this.scheme = 'file';
    this.fsPath = path.resolve(value);
    this.path = this.fsPath.split(path.sep).join('/');
  }
  static file(value) { return new Uri(value); }
  static parse(value) {
    if (value.startsWith('file://')) return new Uri(decodeURIComponent(value.slice(7)));
    const parsed = new URL(value), uri = new Uri(decodeURIComponent(parsed.pathname));
    uri.scheme = parsed.protocol.slice(0, -1);
    uri.path = uri.fsPath = decodeURIComponent(parsed.pathname);
    return uri;
  }
  static joinPath(base, ...parts) {
    const uri = new Uri(path.join(base.fsPath, ...parts));
    uri.scheme = base.scheme;
    if (base.scheme !== 'file') uri.path = uri.fsPath = path.posix.join(base.path, ...parts);
    return uri;
  }
  toString() { return `${this.scheme}://${this.path}`; }
}

export function installVscode() {
  const Module = require('node:module'), previous = Module._load;
  const watchers = [];
  const vscode = {
    Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    RelativePattern: class { constructor(baseUri, pattern) { this.baseUri = this.base = baseUri; this.pattern = pattern; } },
    workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders() { return { dispose() {} }; },
      createFileSystemWatcher(pattern) {
        const callbacks = {};
        const watcher = { pattern, callbacks, disposed: false,
          onDidCreate(callback) { callbacks.create = callback; return { dispose() {} }; },
          onDidChange(callback) { callbacks.change = callback; return { dispose() {} }; },
          onDidDelete(callback) { callbacks.delete = callback; return { dispose() {} }; },
          dispose() { this.disposed = true; }
        };
        watchers.push(watcher);
        return watcher;
      },
      fs: {
        readFile: uri => fs.readFile(uri.fsPath),
        createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }),
        async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
        delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
        async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }; },
        async readDirectory(uri) {
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return Promise.all(entries.map(async entry => {
            if (!entry.isSymbolicLink()) return [entry.name, entry.isDirectory() ? 2 : 1];
            const s = await fs.stat(path.join(uri.fsPath, entry.name));
            return [entry.name, (s.isDirectory() ? 2 : 1) | 64];
          }));
        }
      }
    }
  };
  Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? vscode : previous.call(this, request, parent, isMain);
  };
  return { vscode, watchers, dispose() { Module._load = previous; } };
}

export async function temporaryRoot(context, label) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `limcode-${label}-`)));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

export function authorityAt(root, folders = [], context) {
  const { createVscodeStoragePaths } = compiled('backend/capabilities/vscodeStorage/paths.js');
  const { VscodeConfigurationAuthority } = compiled('backend/reliableKernel/vscodeConfigurationAuthority.js');
  const paths = createVscodeStoragePaths(Uri.file(root));
  return { paths, authority: new VscodeConfigurationAuthority(() => paths, context, folders) };
}

export async function saveGlobal(authority, section, settings) {
  const current = await authority.loadGlobalSettings(section);
  return authority.saveGlobalSettings(section, settings, current.revision);
}

export function provider(overrides = {}) {
  const { createDefaultLlmProviderConfig } = compiled('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
  return { ...createDefaultLlmProviderConfig({ name: 'smoke' }), id: 'smoke-provider', provider: 'openai-compatible',
    model: 'o3', models: [{ id: 'o3', name: 'o3' }, { id: 'o4-mini', name: 'o4-mini' }], modelConfigs: [],
    generationConfig: { thinkingConfig: { thinkingLevel: 'low' } }, ...overrides };
}

export async function seedProvider(authority, config = provider()) {
  await saveGlobal(authority, 'llmProviderConfigs', { configs: [config] });
  await saveGlobal(authority, 'llm', { activeProviderConfigId: config.id });
  return config;
}

export async function ordinaryWire(providerName, model, generationConfig, body = {}) {
  const { LlmCapabilityFullRequestAdapter } = compiled('backend/reliableKernel/llmCapabilityProviderAdapter.js');
  const { dryRunLlmProvider } = compiled('backend/capabilities/llmProvider.js');
  const { LlmEventType } = compiled('backend/world/modules/llm/events.js');
  let projected;
  const adapter = new LlmCapabilityFullRequestAdapter('wire-provider', {
    start(request, emit) { projected = request; emit({ type: LlmEventType.Done, payload: { requestId: request.id } }); },
    abort() {}, dispose() {}
  });
  await adapter.sendFullRequest({
    kind: 'full-model-request', modelRequestId: 'wire-request', conversationId: 'wire-conversation', attemptSeq: '1', socketGeneration: '1',
    providerId: 'wire-provider', modelId: model,
    authoritySnapshot: { model: { providerConfigId: 'wire-provider', provider: providerName, modelId: model, generationConfig, requestBody: body },
      toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} } },
    recipe: { tools: [] }, context: [{ segmentId: 'input', segmentKind: 'message', messageRole: 'user',
      contentType: 'application/vnd.limcode.message+json', content: JSON.stringify({ role: 'user', parts: [{ text: 'smoke' }] }) }],
    attachmentCatalogState: { catalog: [], placements: [] }
  }, { async onEvent() { return { accepted: true, checkpointed: true, terminal: true }; } });
  return (await dryRunLlmProvider(projected, { settings: provider({ id: 'wire-provider', provider: providerName, model,
    baseUrl: 'https://example.invalid/v1', apiKey: '', generationConfig: {}, requestBody: { later_setting: 'must not leak' } }) })).body;
}

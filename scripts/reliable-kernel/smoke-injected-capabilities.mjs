import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { isPathBelow } from './lib/path-containment.mjs';

const root = process.cwd();
const dataRoot = path.resolve(option('data-root') ?? path.join(process.env.HOME, '.local/share/code-server/User/globalStorage/your-publisher.limcode-test'));
const llmModule = await import(pathToFileUrl(path.join(root, 'dist/extension/backend/capabilities/llmProvider.js')));
const mcpModule = await import(pathToFileUrl(path.join(root, 'dist/extension/backend/application/mcpRuntimeManager.js')));
const providers = await readStore(path.join(dataRoot, 'settings', 'llm-provider-configs'));
const servers = await readStore(path.join(dataRoot, 'settings', 'mcp-servers'));
const llmSettings = JSON.parse(await fsp.readFile(path.join(dataRoot, 'settings', 'llm.json'), 'utf8'));
const activeId = typeof llmSettings?.settings?.activeProviderConfigId === 'string' ? llmSettings.settings.activeProviderConfigId : '';
const active = providers.find((record) => record.id === activeId) ?? providers[0];
if (!active || typeof active.id !== 'string' || typeof active.model !== 'string' || !active.model.trim()) {
  throw new Error('激活Provider或模型缺失。');
}

const modelResult = await smokeModel(llmModule.createLlmProviderCapability, active);
const mcpResult = await smokeMcp(mcpModule.McpRuntimeManager, servers);
const receipt = {
  kind: 'limcode-injected-capabilities-smoke',
  checkedAt: new Date().toISOString(),
  model: modelResult,
  mcp: mcpResult
};
const receiptPath = option('receipt');
if (receiptPath) {
  const absolute = path.resolve(receiptPath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const handle = await fsp.open(absolute, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
console.log(JSON.stringify(receipt, null, 2));
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(modelResult.succeeded && mcpResult.succeeded ? 0 : 1);

async function smokeModel(createCapability, config) {
  const capability = createCapability({
    settings: async () => ({ ...config, retryOnError: false, retryMaxAttempts: 0 })
  });
  const requestId = `installed-health-${randomUUID()}`;
  let outputChars = 0;
  let settled = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        capability.abort(requestId);
        reject(namedError('ModelHealthTimeout'));
      }, 90_000);
      const finish = (action) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      capability.start({
        id: requestId,
        contents: [{ role: 'user', parts: [{ text: '健康检查：请只回复 OK。' }] }],
        tools: [],
        model: {
          providerConfigId: config.id,
          provider: config.provider,
          model: config.model
        }
      }, (event) => {
        if (event.type === 'llm:delta' && typeof event.payload?.text === 'string') outputChars += event.payload.text.length;
        if (event.type === 'llm:done') finish(resolve);
        if (event.type === 'llm:error') finish(() => reject(namedError('ModelProviderError')));
      });
    });
    if (outputChars <= 0) throw namedError('ModelEmptyOutput');
    return { succeeded: true, outputNonEmpty: true, outputChars };
  } catch (error) {
    return { succeeded: false, outputNonEmpty: false, outputChars: 0, errorName: safeErrorName(error) };
  } finally {
    capability.dispose();
  }
}

async function smokeMcp(McpRuntimeManager, configuredServers) {
  const manager = new McpRuntimeManager({
    loadGlobalSettings: async () => ({ settings: { servers: configuredServers } })
  });
  try {
    await Promise.race([
      manager.refreshFromSettings({ discover: true }),
      new Promise((_, reject) => setTimeout(() => reject(namedError('McpHealthTimeout')), 90_000))
    ]);
    const sources = manager.sourceRecords();
    const enabled = sources.filter((source) => source.enabled);
    const connected = enabled.filter((source) => source.status === 'connected');
    const toolCount = connected.reduce((sum, source) => sum + (Number.isSafeInteger(source.toolCount) ? source.toolCount : 0), 0);
    return {
      configuredCount: configuredServers.length,
      enabledCount: enabled.length,
      connectedCount: connected.length,
      toolCount,
      succeeded: enabled.length === connected.length
    };
  } catch (error) {
    return {
      configuredCount: configuredServers.length,
      enabledCount: configuredServers.filter((server) => server.enabled !== false).length,
      connectedCount: 0,
      toolCount: 0,
      succeeded: false,
      errorName: safeErrorName(error)
    };
  } finally {
    await manager.dispose();
  }
}

async function readStore(storeRoot) {
  const index = JSON.parse(await fsp.readFile(path.join(storeRoot, 'index.json'), 'utf8'));
  if (!Array.isArray(index.records)) throw new Error('配置index无效。');
  const records = [];
  for (const indexed of index.records) {
    if (typeof indexed.file !== 'string') throw new Error('配置index file无效。');
    const filePath = path.resolve(storeRoot, ...indexed.file.split('/'));
    if (!isPathBelow(path.resolve(storeRoot), filePath)) throw new Error('配置index路径逃逸。');
    const file = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    const key = Object.keys(file).find((candidate) => candidate !== 'schemaVersion' && candidate !== 'savedAt');
    const record = key ? file[key] : undefined;
    if (!record || typeof record !== 'object' || record.id !== indexed.id) throw new Error('配置record无效。');
    records.push(record);
  }
  return records;
}

function namedError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

function safeErrorName(error) {
  const name = error && typeof error.name === 'string' ? error.name : 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(name) ? name : 'UnknownError';
}

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function pathToFileUrl(file) {
  return new URL(`file://${file}`).href;
}

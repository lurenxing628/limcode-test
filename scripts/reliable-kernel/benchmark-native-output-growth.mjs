import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

/**
 * Durable growth of one native (Astra) logical request against the real SQLite/CAS kernel.
 * A scripted provider streams N completed text items in one chain and then the terminal
 * aggregate; the report classifies every new ContentObject by the MessageRevision that owns it
 * (item-only, whole-chain-so-far cumulative, final aggregate) and by content type.
 */

const root = process.cwd();
const compiledRoot = path.resolve(root, option('compiled-root') ?? 'dist/extension');
const kernel = await import(pathToFileURL(path.join(compiledRoot, 'backend/reliableKernel/index.js')).href);
const itemCounts = (option('items') ?? '5,20,50,100').split(',').map((value) => positiveInteger(value, 'items'));
const itemBytes = positiveInteger(option('item-bytes') ?? '2048', 'item-bytes');
const outputPath = option('output');

const PROVIDER_ID = 'provider-native-growth';
const MODEL_ID = 'gpt-6-astra';
const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';
const RESPONSE_ID = 'r1';
const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };

const rows = [];
for (const items of itemCounts) rows.push(await measureChain(items));

const report = {
  kind: 'limcode-native-output-growth',
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  itemBytes,
  caveats: [
    'one synthetic logical request streams N completed text items in one provider response; tool calls, reasoning signatures and multi-response chains share the same per-item cumulative write path but are not exercised',
    'item text is deterministic pseudo-random ASCII so identical-content deduplication cannot hide growth',
    'itemOnlyAndAggregateBytes is the storage an O(N) design would keep for the same chain; it excludes any per-item composite descriptor such a design would add',
    'readAllRevisionsMs/readItemRevisionsMs time reading the Message revisions the way NativeRequestSession.reconcile does today versus items only; timings are single-run and machine-dependent',
    'all payloads are synthetic and the report contains counts, bytes and timings only'
  ],
  rows
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await fs.writeFile(path.resolve(root, outputPath), serialized, 'utf8');
process.stdout.write(serialized);

async function measureChain(items) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-native-growth-benchmark-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const texts = Array.from({ length: items }, (_, index) => pseudoRandomText(index, itemBytes));
  const adapter = nativeAdapter(texts);
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(authority, dependencies(adapter));
    const conversationId = `native-growth-${items}`;
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: 'native growth benchmark', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${conversationId}:agent`, conversation_id: conversationId, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    const started = await app.turns.input({
      source: { kind: 'command', key: `${conversationId}:input` },
      conversationId,
      leaseOwnerId: `${conversationId}:owner`,
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      content: 'stream native items'
    });
    const turnId = started.turnId;
    const lease = (await list(app, 'ExecutionLease', { turn_id: turnId }))[0];
    const fence = {
      id: lease.id,
      conversationId: lease.conversation_id,
      turnId: lease.turn_id,
      ownerId: lease.owner_id,
      hostBootId: lease.host_boot_id,
      generation: BigInt(lease.generation)
    };
    const contentBefore = new Set((await list(app, 'ContentObject')).map((row) => row.id));
    const casBefore = await casFiles(parent);
    const driveStarted = performance.now();
    const outcome = await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(turnId));
    const driveMs = performance.now() - driveStarted;
    if (outcome.terminalStatus !== 'completed') {
      throw new Error(`Benchmark Turn ended ${outcome.terminalStatus}, expected completed.`);
    }

    const [modelRequest] = await list(app, 'ModelRequest', { turn_id: turnId });
    const modelRequestId = modelRequest.id;
    const messageId = kernel.assistantMessageIdFor(turnId, modelRequestId);
    const revisions = (await list(app, 'MessageRevision', { message_id: messageId }))
      .sort((left, right) => compareBigInt(left.revision_seq, right.revision_seq));
    const itemIds = new Set(texts.map((_, index) =>
      kernel.nativeItemRevisionId(turnId, modelRequestId, `content:${RESPONSE_ID}:${index}`)));
    const cumulativeIds = new Set(texts.map((_, index) =>
      kernel.nativeCumulativeRevisionId(turnId, modelRequestId, `content:${RESPONSE_ID}:${index}`)));
    const aggregateId = kernel.assistantMessageRevisionIdFor(turnId, modelRequestId);

    const contentRows = (await list(app, 'ContentObject')).filter((row) => !contentBefore.has(row.id));
    const contentById = new Map(contentRows.map((row) => [row.id, row]));
    const allContentById = new Map((await list(app, 'ContentObject')).map((row) => [row.id, row]));
    const revisionClass = (revision) => itemIds.has(revision.id)
      ? 'item'
      : cumulativeIds.has(revision.id) ? 'cumulative' : revision.id === aggregateId ? 'aggregate' : 'other';
    const revisionClasses = { item: 0, cumulative: 0, aggregate: 0, other: 0 };
    const keysByClass = { item: new Set(), cumulative: new Set(), aggregate: new Set(), other: new Set() };
    for (const revision of revisions) {
      const kind = revisionClass(revision);
      revisionClasses[kind] += 1;
      const content = allContentById.get(revision.content_object_id);
      if (content) keysByClass[kind].add(content.storage_key ?? content.sha256 ?? content.id);
    }
    const bytesByKey = new Map();
    for (const row of allContentById.values()) {
      bytesByKey.set(row.storage_key ?? row.sha256 ?? row.id, Number(row.byte_length));
    }
    const sumKeys = (keys) => [...keys].reduce((total, key) => total + (bytesByKey.get(key) ?? 0), 0);
    const retainedByOthers = new Set([...keysByClass.item, ...keysByClass.aggregate, ...keysByClass.other]);
    const cumulativeOnlyKeys = new Set([...keysByClass.cumulative].filter((key) => !retainedByOthers.has(key)));

    const byContentType = {};
    for (const row of contentById.values()) {
      const entry = byContentType[row.content_type] ?? { objects: 0, logicalBytes: 0 };
      entry.objects += 1;
      entry.logicalBytes += Number(row.byte_length);
      byContentType[row.content_type] = entry;
    }
    const casAfter = await casFiles(parent);
    const newFiles = [...casAfter.entries()].filter(([file]) => !casBefore.has(file));
    const physicalBytes = newFiles.reduce((total, [, stat]) => total + stat.size, 0);
    const allocatedBytes = newFiles.reduce((total, [, stat]) => total + stat.blocks * 512, 0);

    const readAll = await timedRead(app, revisions, allContentById);
    const readItems = await timedRead(app, revisions.filter((revision) => itemIds.has(revision.id)), allContentById);
    const messageTypeBytes = byContentType[MESSAGE_CONTENT_TYPE]?.logicalBytes ?? 0;

    return {
      items,
      driveMs: round(driveMs),
      messageRevisions: revisionClasses,
      newContentObjects: contentRows.length,
      newCasFiles: newFiles.length,
      newCasPhysicalBytes: physicalBytes,
      newCasAllocatedBytes: allocatedBytes,
      byContentType,
      messageBytes: {
        itemRevisions: sumKeys(keysByClass.item),
        cumulativeRevisionsOnly: sumKeys(cumulativeOnlyKeys),
        aggregateRevision: sumKeys(keysByClass.aggregate),
        itemOnlyAndAggregateBytes: messageTypeBytes - sumKeys(cumulativeOnlyKeys),
        cumulativeShareOfMessageBytes: messageTypeBytes > 0 ? round(sumKeys(cumulativeOnlyKeys) / messageTypeBytes) : 0,
        cumulativeShareOfAllNewCasBytes: physicalBytes > 0 ? round(sumKeys(cumulativeOnlyKeys) / physicalBytes) : 0
      },
      reconcileRead: {
        allRevisionsBytes: readAll.bytes,
        allRevisionsMs: readAll.ms,
        itemRevisionsBytes: readItems.bytes,
        itemRevisionsMs: readItems.ms
      }
    };
  } finally {
    await app?.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function timedRead(app, revisions, contentById) {
  const started = performance.now();
  let bytes = 0;
  for (const revision of revisions) {
    const metadata = contentById.get(revision.content_object_id);
    bytes += (await app.contentStore.read(metadata)).length;
  }
  return { bytes, ms: round(performance.now() - started) };
}

function nativeAdapter(texts) {
  return {
    providerId: PROVIDER_ID,
    async materializeNativeToolOutput(outputs) { return outputs; },
    async sendFullRequest(_request, controls) {
      let streamSeq = 0;
      const emit = (kind, content, extra = {}) => {
        streamSeq += 1;
        return controls.onEvent({ kind, streamSeq: String(streamSeq), content, ...extra });
      };
      const controller = {
        responseId: RESPONSE_ID,
        connectionGeneration: 1,
        streamId: undefined,
        async steer() { throw new Error('No steering in the growth benchmark.'); },
        async submitToolResults() { throw new Error('No tool results in the growth benchmark.'); },
        endLogicalRequest() {}
      };
      controls.native?.onController?.(controller);
      try {
        await emit('native_control', { type: 'response.created', responseId: RESPONSE_ID, capabilities });
        const parts = [];
        for (const [ordinal, text] of texts.entries()) {
          const outputItem = { id: `item-${ordinal}`, ordinal, providerResponseId: RESPONSE_ID };
          await emit('output_delta', { type: 'text_delta', text, outputItem });
          await emit('output_item_done', { type: 'output_item_done', outputItem });
          parts.push({ text, outputItem });
        }
        await emit('native_control', { type: 'response.completed', responseId: RESPONSE_ID,
          usage: { input_tokens: 100, output_tokens: texts.length, total_tokens: 100 + texts.length } });
        await emit('completed', { role: 'model', parts },
          { usage: { input_tokens: 100, output_tokens: texts.length, total_tokens: 100 + texts.length } });
      } finally {
        controls.native?.onController?.(undefined);
      }
    }
  };
}

function dependencies(adapter) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: MODEL_ID }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: PROVIDER_ID,
                provider: 'openai-responses',
                modelId: MODEL_ID,
                baseUrl: 'https://native-growth-benchmark.invalid/v1',
                openaiResponsesTransport: 'http',
                nativeResponses: { enabled: true },
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 10_000_000,
                contextWindowTokens: 12_000_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: { id: 'tools-none', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              systemPrompt: { id: 'prompt-empty', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: { resolve() { return adapter; } },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('No tool dispatch in the growth benchmark.'); },
      async scheduleAdmittedCall() { throw new Error('No tool admission in the growth benchmark.'); }
    }
  };
}

async function list(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1000
  }))).snapshot;
}

async function casFiles(parent) {
  const files = new Map();
  const walk = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && absolute.includes(`${path.sep}cas${path.sep}`)) files.set(absolute, await fs.stat(absolute));
    }
  };
  await walk(parent);
  return files;
}

function pseudoRandomText(seed, length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,';
  let state = (seed + 1) * 2654435761 >>> 0;
  let text = '';
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    text += alphabet[state % alphabet.length];
  }
  return text;
}

function compareBigInt(left, right) {
  const a = BigInt(String(left));
  const b = BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RangeError(`${label} must be a positive integer.`);
  return parsed;
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const k = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const repo = domain => k.DOMAIN_REPOSITORIES.domain(domain);

for (const scenario of ['invalid-image', 'invalid-resource', 'oversized-audio', 'explicit-tool-error', 'non-json-field', 'nested-inline-data']) {
  test(`MCP ${scenario} retains observed execution result, useful text and no-retry warning`, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-mcp-result-integrity-'));
    let database;
    try {
      const authority = new k.RootAuthority(() => path.join(temporary, 'runtime'));
      await k.initializeEmptyRuntimeRoot(authority);
      database = await k.RuntimeDatabase.open(authority);
      const store = new k.ContentAddressedStore(authority, database.binding);
      const attachments = new k.AttachmentIngestService(database, store, { async loadGlobalSettings() { return { settings: { maxStoredInlineFileMb: 1 } }; } });
      const effects = new k.EffectControlPlane(database, store, { attachments });
      const now = new Date().toISOString();
      await database.transaction([
        repo('Conversation').insert({ id: 'conversation', title: 'MCP result fixture', status: 'active', created_at: now, updated_at: now }),
        repo('Turn').insert({ id: 'turn', conversation_id: 'conversation', status: 'active', created_at: now, updated_at: now, terminal_at: null }),
        repo('ExecutionLease').insert({ id: 'lease', conversation_id: 'conversation', turn_id: 'turn', owner_id: 'fixture', host_boot_id: database.hostBootId,
          generation: 1n, acquired_at: now, expires_at: new Date(Date.now() + 600_000).toISOString() })
      ]);
      await effects.createToolCall({ source: { kind: 'internal', key: 'create' }, toolCallId: 'tool', turnId: 'turn', toolName: 'fixture_mcp', arguments: {} });
      const badPart = scenario === 'invalid-resource' ? { type: 'resource', resource: { uri: 'fixture:///report.pdf', mimeType: 'application/pdf', blob: '%%%INVALID%%%' } }
        : scenario === 'oversized-audio' ? { type: 'audio', mimeType: 'audio/wav', data: Buffer.alloc(1024 * 1024 + 1).toString('base64') }
        : { type: 'image', mimeType: 'image/png', data: '%%%INVALID%%%' };
      let calls = 0;
      const dispatcher = new k.McpEffectDispatcher(database, effects, {
        async toolAnnotations() { return {}; },
        async callTool() {
          calls++;
          return { content: [{ type: 'text', text: 'External action returned useful evidence' }, ...(scenario === 'non-json-field' ? [] : [badPart])],
            ...(scenario === 'nested-inline-data' ? { structuredContent: { text: 'Useful attachment sibling', inlineData: { mimeType: 'image/png', data: '%%%INVALID%%%', storage: 'embedded', status: 'available' } } } : {}),
            ...(scenario === 'explicit-tool-error' ? { isError: true } : {}), ...(scenario === 'non-json-field' ? { invalid: new Date(0) } : {}) };
        }
      }, { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } });
      const prepared = await dispatcher.prepare({ source: { kind: 'internal', key: 'prepare' }, toolCallId: 'tool', serverId: 'fixture', toolName: 'action' });
      const result = await dispatcher.dispatch(prepared.effectIntentId);
      const expected = scenario === 'explicit-tool-error' ? 'failed' : 'succeeded';
      assert.equal(result.observation.outcome, expected);
      assert.equal(result.terminal.status, expected);
      assert.equal(result.observation.automaticRetry, false);
      assert.equal(result.observation.result.content[0].text, 'External action returned useful evidence');
      assert.equal(result.observation.parts, undefined);
      if (scenario === 'nested-inline-data') assert.equal(result.observation.result.structuredContent.text, 'Useful attachment sibling');
      assert.ok(scenario === 'non-json-field' ? result.observation.resultProcessingError : result.observation.attachmentError);
      const receipt = (await database.snapshotAll(repo('EffectReceipt').list({ limit: 100, orderBy: { column: 'id', direction: 'asc' } }))).snapshot[0];
      assert.equal(receipt.outcome, expected);
      const recovered = await dispatcher.recoverDispatched({ source: { kind: 'recovery', key: 'recover' }, effectIntentId: prepared.effectIntentId });
      assert.equal(recovered.status, expected);
      assert.equal(calls, 1);
      const durable = JSON.parse((await store.read((await database.snapshot([repo('ContentObject').get(receipt.response_object_id)])).snapshot[0])).toString('utf8'));
      assert.equal(durable.outcome, expected);
      assert.equal(durable.result.content[0].text, 'External action returned useful evidence');
      assert.equal(durable.automaticRetry, false);
    } finally {
      if (database) await database.close();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
}

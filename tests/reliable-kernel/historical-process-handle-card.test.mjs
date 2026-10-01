import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { historicalProcessHandleCard } = require(path.join(root, 'backend/reliableKernel/historicalProcessHandleCard.js'));
const { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION } = require(path.join(root, 'backend/reliableKernel/modelHandleCatalog.js'));

function fixture({ foreign = false, mismatched = false } = {}) {
  const domains = {
    ProcessCompletionSourceLink: [{ id: 'source', process_id: 'process-one', conversation_id: foreign ? 'other' : 'own',
      source_turn_id: 'turn', source_tool_call_id: 'call', created_at: '2026-10-01T00:00:00Z' }],
    Process: [{ id: 'process-one', status: 'running', started_at: '2026-10-01T00:00:00Z' }],
    Turn: [{ id: 'turn', conversation_id: mismatched ? 'other' : 'own' }],
    ToolCall: [{ id: 'call', turn_id: 'turn', tool_name: 'shell', arguments_object_id: 'args' }],
    ContentObject: [{ id: 'args', byte_length: 42 }]
  };
  const database = {
    async snapshotAll(read) { return { snapshot: (domains[read.domain] ?? []).filter(row =>
      Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value)) }; },
    async snapshot(reads) { return { snapshot: reads.map(read => (domains[read.domain] ?? []).find(row => row.id === read.id)) }; },
    transaction() { throw new Error('The recovery card must be read-only'); }
  };
  let casReads = 0;
  const store = { async read() { casReads++; return Buffer.from(JSON.stringify({ command: 'npm run verify' })); } };
  return { database, store, casReads: () => casReads };
}

const catalog = { identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
  entries: [{ kind: 'process', ref: 'P8', target: 'process-one' }], retiredRefs: ['P1'] };

test('repaired process card supplies current identity and command without suggesting a retired alias', async () => {
  const f = fixture();
  const card = await historicalProcessHandleCard(f.database, f.store, 'own', catalog);
  assert.match(card, /"processRef":"P8"/);
  assert.match(card, /"command":"npm run verify"/);
  assert.match(card, /"status":"running"/);
  assert.match(card, /None is an alias/);
  assert.doesNotMatch(card, /process-one|"processRef":"P1"/);
});

test('fork or mismatched process provenance cannot expose another Conversation process', async () => {
  for (const options of [{ foreign: true }, { mismatched: true }]) {
    const f = fixture(options);
    const card = await historicalProcessHandleCard(f.database, f.store, 'own', catalog);
    assert.match(card, /"processes":\[\]/);
    assert.doesNotMatch(card, /npm run verify|"processRef":"P8"/);
    assert.equal(f.casReads(), 0);
  }
});

test('normal conversations do not read extra process history', async () => {
  assert.equal(await historicalProcessHandleCard({ snapshotAll() { throw Error('unexpected read'); } }, {}, 'own',
    { entries: catalog.entries }), undefined);
});

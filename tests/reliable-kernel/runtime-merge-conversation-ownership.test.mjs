import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = (name) => require(path.join(compiled, 'backend/reliableKernel', name));
const Database = require('better-sqlite3');
const { RUNTIME_DOMAIN_SCHEMAS } = kernel('schema/domainManifest.js');
const { RUNTIME_MERGE_CONVERSATION_OWNERSHIP: rules, createRuntimeMergeConversationOwnership, runtimeMergeRecipeContentReferences, runtimeMergeOwnershipEdges, runtimeMergeContentIdentityEdges, RUNTIME_MERGE_CONTENT_REFERENCE_COLUMNS } = kernel('runtimeMergeConversationOwnership.js');

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const byKey = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema]));
  // Raw-column ownership deliberately runs before codec validation. These tables exercise that
  // boundary without requiring unrelated payloads, leases, or valid execution aggregates.
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    db.exec(`CREATE TABLE "${schema.table}" (${schema.columns.map((c) => `"${c.name}" ${c.type}`).join(',')})`);
  }
  const insert = (domain, row) => {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO "${byKey.get(domain).table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
  };
  return { db, insert, resolver: createRuntimeMergeConversationOwnership(db) };
}

test('all 113 domains have explicit valid paths and raw rows resolve through them', (t) => {
  const { insert, resolver } = fixture(t);
  assert.deepEqual(Object.keys(rules).sort(), RUNTIME_DOMAIN_SCHEMAS.map((s) => s.key).sort());
  const schemas = new Map(RUNTIME_DOMAIN_SCHEMAS.map((s) => [s.key, s]));
  const rows = new Map(RUNTIME_DOMAIN_SCHEMAS.map((s) => [s.key, { id: s.key === 'Conversation' ? 'conversation' : s.key }]));
  for (const [domain, rule] of Object.entries(rules)) {
    for (const edge of rule.paths) {
      const owner = schemas.get(edge.domain);
      assert.ok(owner, `${domain}: unknown owner`);
      assert.ok(schemas.get(edge.direction === 'reference' ? domain : edge.domain).columns.some((c) => c.name === edge.column), `${domain}.${edge.column}`);
      if (edge.direction === 'reference') {
        rows.get(domain)[edge.column] = edge.domain === 'Conversation' ? 'conversation' : edge.domain;
        if (edge.when) rows.get(domain)[edge.when[0]] = edge.when[1];
      } else {
        rows.get(edge.domain)[edge.column] = rows.get(domain).id;
      }
    }
  }
  for (const [domain, row] of rows) insert(domain, row);
  for (const [domain, rule] of Object.entries(rules)) {
    const owners = resolver.resolve(domain, rows.get(domain));
    assert.deepEqual(owners && [...owners].sort(), rule.category === 'content-derived' ? [] : ['conversation'], domain);
  }
});

test('shared messages resolve all branches while membership rows retain their own conversation', (t) => {
  const { insert, resolver } = fixture(t);
  insert('Message', { id: 'message' });
  for (const id of ['alpha', 'beta']) insert('MessagePartOfConversation', { id: `member-${id}`, conversation_id: id, message_id: 'message' });
  assert.deepEqual([...resolver.resolve('Message', { id: 'message', broken_column: true })].sort(), ['alpha', 'beta']);
  assert.deepEqual([...resolver.resolve('MessagePartOfConversation', { id: 'member-alpha', conversation_id: 'alpha', message_id: 'message' })], ['alpha']);
  assert.equal(resolver.resolve('Turn', { id: 'broken', conversation_id: 5 }), undefined);
});

test('cross-conversation soft links retain both endpoints, including deleted peers', (t) => {
  const { insert, resolver } = fixture(t);
  insert('CollaborationMessage', { id: 'message' });
  insert('CollaborationMessageSourceLink', { id: 'source', message_id: 'message', conversation_id: 'deleted-peer' });
  insert('CollaborationMessageTargetLink', { id: 'target', message_id: 'message', conversation_id: 'receiver' });
  assert.deepEqual([...resolver.resolve('CollaborationMessagePayloadLink', { id: 'payload', message_id: 'message' })].sort(), ['deleted-peer', 'receiver']);
});

test('child tree ownership expands upward and downward without recursion or dropping siblings', (t) => {
  const { insert, resolver } = fixture(t);
  insert('Turn', { id: 'parent-turn', conversation_id: 'parent' });
  for (const id of ['one', 'two']) {
    insert('ChildExecution', { id: `child-${id}`, child_conversation_id: id });
    insert('ChildExecutionParentLink', { id: `parent-${id}`, child_execution_id: `child-${id}`, parent_turn_id: 'parent-turn' });
  }
  assert.deepEqual([...resolver.expandChildTrees(new Set(['one']))].sort(), ['one', 'parent', 'two']);
});

test('missing content follows shared attachment identities and exact recipe edges', (t) => {
  const { insert, resolver } = fixture(t);
  insert('Attachment', { id: 'attachment', content_object_id: 'missing' });
  insert('ConversationAttachmentHandleLink', { id: 'handle', conversation_id: 'owner', attachment_id: 'attachment' });
  assert.deepEqual([...resolver.resolveContentReferences(new Set(['missing']))], ['owner']);
  assert.deepEqual([...runtimeMergeRecipeContentReferences({ toolsReference: { contentObjectId: 'tools' }, modelHandleCatalogReference: { baseContentObjectId: 'catalog' }, arbitrary: { contentObjectId: 'ignored' } })].sort(), ['catalog', 'tools']);
  assert.deepEqual([...resolver.resolve('CommandReceipt', { id: 'commit', source_kind: 'internal', source_key: 'historical-merge-commit:receipt', conversation_id: null, turn_id: null })], []);
});


test('single-pass edge helpers invert membership and keep content identities separate', () => {
  const row = { id: 'member', conversation_id: 'branch', message_id: 'shared' };
  assert.deepEqual([...runtimeMergeOwnershipEdges('MessagePartOfConversation', row)], [
    { fromDomain: 'MessagePartOfConversation', fromId: 'member', toDomain: 'Conversation', toId: 'branch' },
    { fromDomain: 'Message', fromId: 'shared', toDomain: 'MessagePartOfConversation', toId: 'member' }
  ]);
  assert.deepEqual([...runtimeMergeContentIdentityEdges('AttachmentLink', { id: 'link', attachment_id: 'attachment' })], [
    { fromDomain: 'AttachmentLink', fromId: 'link', toDomain: 'Attachment', toId: 'attachment' }
  ]);
  assert.ok(RUNTIME_MERGE_CONTENT_REFERENCE_COLUMNS.get('ModelRequest').includes('recipe_object_id'));
  assert.ok(RUNTIME_MERGE_CONTENT_REFERENCE_COLUMNS.get('RuntimeDeliveryAnswerPresentation').includes('body_content_object_id'));
});

test('冲突原因覆盖先前未完成工作并传到关联对话，避免收尾修改冲突来源', async (t) => {
  const {db,insert} = fixture(t);
  const {RuntimeMergeConversationExclusions} = kernel('runtimeMergeConversationExclusions.js');
  const exclusions = new RuntimeMergeConversationExclusions(db);
  t.after(()=>exclusions.close());
  for (const id of ['parent','branch','unrelated']) {
    const row = {id,title:id};
    insert('Conversation',row);
    exclusions.observe('Conversation',row);
  }
  const link = {id:'branch-link',source_conversation_id:'parent',target_conversation_id:'branch'};
  insert('ConversationBranchLink',link);
  exclusions.observe('ConversationBranchLink',link);
  exclusions.exclude('Conversation',{id:'parent'},'runtime-data-set-merge-unfinished-work');
  await exclusions.finish(1);
  exclusions.exclude('Conversation',{id:'branch'},'runtime-data-set-merge-conflict');
  await exclusions.finish(1);
  assert.deepEqual(exclusions.excluded().map(row=>[row.conversationId,row.code]),[
    ['branch','runtime-data-set-merge-conflict'],['parent','runtime-data-set-merge-conflict']
  ]);
  assert.equal(exclusions.includes('Conversation','unrelated'),false);
});

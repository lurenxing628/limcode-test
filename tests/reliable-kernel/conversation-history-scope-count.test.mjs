import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { conversationHistoryTotalQuery } = require(path.join(compiledRoot, 'backend/reliableKernel/clientProjection.js'));
const NativeDatabase = require('better-sqlite3');
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

const PROJECTS = {
  p0: 'file:///workspace/p0',
  p1: 'file:///workspace/p1',
  // A URI sharing p1 as a prefix must never be counted with p1.
  p10: 'file:///workspace/p10',
  empty: 'file:///workspace/empty'
};

/** The pre-rewrite COUNT: every Conversation probed through a correlated primary-link subquery. */
const LEGACY_COUNT_SQL = {
  all: 'SELECT COUNT(*) AS total FROM conversation WHERE 1 = 1',
  unbound: `SELECT COUNT(*) AS total FROM conversation WHERE NOT EXISTS (
    SELECT 1 FROM conversation_project_link AS scope_link
     WHERE scope_link.conversation_id = conversation.id AND scope_link.role = 'primary')`,
  project: `SELECT COUNT(*) AS total FROM conversation WHERE EXISTS (
    SELECT 1 FROM conversation_project_link AS scope_link
      JOIN project_context AS scope_project ON scope_project.id = scope_link.project_context_id
     WHERE scope_link.conversation_id = conversation.id AND scope_link.role = 'primary'
       AND scope_project.uri = @projectFolderUri)`
};

async function historyFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-count-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'history-count' });
  t.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const at = (index) => new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString();
  await database.transaction(Object.entries(PROJECTS).map(([key, uri]) => row('ProjectContext', {
    id: `project-${key}`, kind: 'folder', uri, name: key, created_at: at(0), updated_at: at(0)
  })));
  const layout = [['p0', 40], ['p1', 12], ['p10', 5], [null, 9]];
  const expected = { all: 0, unbound: 0, p0: 0, p1: 0, p10: 0, empty: 0 };
  let index = 0;
  for (const [project, count] of layout) {
    const steps = [];
    for (let offset = 0; offset < count; offset += 1) {
      index += 1;
      const id = `conversation-${String(index).padStart(4, '0')}`;
      steps.push(row('Conversation', { id, title: id, status: 'active', created_at: at(index), updated_at: at(index) }));
      if (project) {
        steps.push(row('ConversationProjectLink', {
          id: `link-${id}`, conversation_id: id, project_context_id: `project-${project}`,
          role: 'primary', created_at: at(index), updated_at: at(index)
        }));
      }
      expected.all += 1;
      expected[project ?? 'unbound'] += 1;
    }
    await database.transaction(steps);
  }
  // Deleted Conversations cascade their project links; neither count may keep them.
  const deleted = { p0: ['conversation-0003', 'conversation-0017', 'conversation-0040'], p1: ['conversation-0041', 'conversation-0052'], unbound: ['conversation-0060'] };
  for (const [scope, ids] of Object.entries(deleted)) {
    await database.transaction(ids.map((id) => kernel.DOMAIN_REPOSITORIES.domain('Conversation').delete(id)));
    expected.all -= ids.length;
    expected[scope] -= ids.length;
  }
  return { root, database, expected };
}

function legacyTotal(native, scopeKind, projectFolderUri) {
  const sql = LEGACY_COUNT_SQL[scopeKind];
  const params = scopeKind === 'project' ? { projectFolderUri: projectFolderUri.trim() } : {};
  return Number(native.prepare(sql).get(params).total);
}

test('按项目索引计数与原全表计数在 all/project/unbound 及删除后完全一致', async (t) => {
  const { root, database, expected } = await historyFixture(t);
  const native = new NativeDatabase(root.binding.paths.databasePath, { readonly: true });
  t.after(() => native.close());
  const cases = [
    { scopeKind: 'all', expected: expected.all },
    { scopeKind: 'unbound', expected: expected.unbound },
    { scopeKind: 'project', projectFolderUri: PROJECTS.p0, expected: expected.p0 },
    { scopeKind: 'project', projectFolderUri: PROJECTS.p1, expected: expected.p1 },
    // Project URIs are trimmed exactly as the scoped page query does.
    { scopeKind: 'project', projectFolderUri: `  ${PROJECTS.p1}\t`, expected: expected.p1 },
    { scopeKind: 'project', projectFolderUri: PROJECTS.p10, expected: expected.p10 },
    { scopeKind: 'project', projectFolderUri: PROJECTS.empty, expected: 0 },
    { scopeKind: 'project', projectFolderUri: 'file:///workspace/never-registered', expected: 0 }
  ];
  assert.deepEqual(
    { all: expected.all, unbound: expected.unbound, p0: expected.p0, p1: expected.p1, p10: expected.p10 },
    { all: 60, unbound: 8, p0: 37, p1: 10, p10: 5 }
  );
  for (const item of cases) {
    const projection = await database.conversationHistoryProjection({
      scopeKind: item.scopeKind,
      ...(item.projectFolderUri ? { projectFolderUri: item.projectFolderUri } : {}),
      limit: 7
    });
    const label = `${item.scopeKind}:${item.projectFolderUri ?? ''}`;
    assert.equal(projection.total, item.expected, label);
    assert.equal(projection.total, legacyTotal(native, item.scopeKind, item.projectFolderUri ?? ''), label);
    assert.equal(projection.seedRows.length, Math.min(7, item.expected), label);
    assert.equal(projection.hasMore, item.expected > 7, label);
  }
});

test('项目历史计数从唯一 URI 索引定位并只走项目关联索引', async (t) => {
  const { root } = await historyFixture(t);
  const native = new NativeDatabase(root.binding.paths.databasePath, { readonly: true });
  t.after(() => native.close());
  const query = conversationHistoryTotalQuery({ scopeKind: 'project', projectFolderUri: PROJECTS.p0 });
  const plan = native.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(query.params).map((step) => String(step.detail));
  assert.ok(plan.some((detail) => /^SEARCH scope_project USING (COVERING )?INDEX ux_project_context_01 \(uri=\?\)$/.test(detail)), plan.join('\n'));
  assert.ok(plan.some((detail) => /^SEARCH scope_link USING (COVERING )?INDEX ix_conversation_project_link_02 \(project_context_id=\?\)$/.test(detail)), plan.join('\n'));
  assert.ok(plan.every((detail) => !/SCAN|CORRELATED/.test(detail)), plan.join('\n'));
  assert.ok(plan.every((detail) => !/\bconversation\b/.test(detail.replace(/conversation_project_link/g, ''))), plan.join('\n'));
  const legacyPlan = native.prepare(`EXPLAIN QUERY PLAN ${LEGACY_COUNT_SQL.project}`).all({ projectFolderUri: PROJECTS.p0 })
    .map((step) => String(step.detail));
  assert.ok(legacyPlan.some((detail) => /^SCAN conversation\b/.test(detail)), '对照：原计数确实逐个扫描 Conversation');

  for (const scopeKind of ['all', 'unbound']) {
    const scoped = conversationHistoryTotalQuery({ scopeKind });
    assert.equal(
      Number(native.prepare(scoped.sql).get(scoped.params).total),
      Number(native.prepare(LEGACY_COUNT_SQL[scopeKind]).get().total),
      scopeKind
    );
  }
});

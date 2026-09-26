import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(name, parent, isMain) {
  return name === 'vscode'
    ? { EventEmitter: class { event = () => {}; }, Uri: { parse: (text) => ({ toString: () => text }) } }
    : originalLoad.call(this, name, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiledRoot, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));
const conversations = kernel.DOMAIN_REPOSITORIES.domain('Conversation');
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

const P = 'file:///workspace/project-p';
const Q = 'file:///workspace/project-q';
const PAGE = 5;

/**
 * The sidebar refresh path re-sends the cursor of the page it is showing. These tests drive the
 * real Facade page query against a real Runtime worker and commit through the same writer.
 */
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-paging-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'history-paging' });
  t.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 8, 1) + (clock += 1) * 1000).toISOString();
  const create = async (id, projectUri) => {
    const at = now();
    await database.transaction([
      row('Conversation', { id, title: id, status: 'active', created_at: at, updated_at: at }),
      ...(projectUri ? [row('ConversationProjectLink', {
        id: `link-${id}`, conversation_id: id, project_context_id: projectUri === P ? 'project-p' : 'project-q',
        role: 'primary', created_at: at, updated_at: at
      })] : [])
    ]);
  };
  const touch = (id) => database.transaction([conversations.update(id, { updated_at: now() })]);
  const remove = (ids) => database.transaction(ids.map((id) => conversations.delete(id)));
  const at = now();
  await database.transaction([
    row('ProjectContext', { id: 'project-p', kind: 'folder', uri: P, name: 'P', created_at: at, updated_at: at }),
    row('ProjectContext', { id: 'project-q', kind: 'folder', uri: Q, name: 'Q', created_at: at, updated_at: at })
  ]);
  // Interleave projects so every P page boundary sits between foreign rows as well.
  for (let index = 1; index <= 13; index += 1) {
    await create(`p-${String(index).padStart(2, '0')}`, P);
    if (index % 3 === 0) await create(`q-${String(index).padStart(2, '0')}`, Q);
    if (index % 5 === 0) await create(`u-${String(index).padStart(2, '0')}`, undefined);
  }
  const facade = Object.create(Facade.prototype);
  Object.assign(facade, {
    product: { application: { database }, configuration: { agents: async () => [] } },
    historyEntries: [],
    originLinks: [],
    historyPreviewByRevisionId: new Map(),
    historyTitleByRevisionId: new Map(),
    startHydration: async () => undefined
  });
  const page = (scopeKind, cursor, projectFolderUri = scopeKind === 'project' ? P : undefined) =>
    facade.getConversationHistoryPage({ scopeKind, projectFolderUri, cursor, limit: PAGE });
  return { root, database, create, touch, remove, page };
}

const ids = (page) => page.entries.map((entry) => entry.id);

test('其他项目连续提交后，本项目历史分页停留在原页且游标不变', async (t) => {
  const f = await fixture(t);
  const first = await f.page('project');
  assert.deepEqual(ids(first), ['p-13', 'p-12', 'p-11', 'p-10', 'p-09']);
  assert.equal(first.pageInfo.total, 13);
  const second = await f.page('project', first.pageInfo.nextCursor);
  assert.deepEqual(ids(second), ['p-08', 'p-07', 'p-06', 'p-05', 'p-04']);
  assert.equal(second.pageInfo.pageIndex, 1);

  for (let index = 0; index < 20; index += 1) {
    if (index % 2 === 0) await f.touch(`q-${String(3 * (1 + (index % 4))).padStart(2, '0')}`);
    else await f.create(`q-extra-${index}`, Q);
  }
  // Exactly what SidebarEntryView re-sends on every history change notification.
  const refreshed = await f.page('project', first.pageInfo.nextCursor);
  assert.equal(refreshed.pageInfo.pageIndex, 1, '无关项目提交不得把分页重置到第一页');
  assert.deepEqual(ids(refreshed), ids(second));
  assert.equal(refreshed.pageInfo.cursor, second.pageInfo.cursor, '同一页的游标跨提交保持稳定');
  assert.equal(refreshed.pageInfo.previousCursor, second.pageInfo.previousCursor);
  assert.equal(refreshed.pageInfo.nextCursor, second.pageInfo.nextCursor);
  assert.equal(refreshed.pageInfo.total, 13);
  const third = await f.page('project', refreshed.pageInfo.nextCursor);
  assert.deepEqual(ids(third), ['p-03', 'p-02', 'p-01']);
  assert.equal(third.pageInfo.pageIndex, 2);
  assert.equal(third.pageInfo.hasNext, false);
});

test('本项目新建、更新、删除在原页上收敛：新会话在顶部，移到顶部的不重复，删除的消失', async (t) => {
  const f = await fixture(t);
  const first = await f.page('project');
  const secondCursor = first.pageInfo.nextCursor;

  await f.create('p-new', P);
  await f.touch('p-06');
  await f.remove(['p-05']);

  const second = await f.page('project', secondCursor);
  assert.equal(second.pageInfo.pageIndex, 1);
  assert.deepEqual(ids(second), ['p-08', 'p-07', 'p-04', 'p-03', 'p-02'],
    '更新后移到顶部的 p-06 与已删除的 p-05 都不再出现在第二页');
  assert.equal(second.pageInfo.total, 13);
  const top = await f.page('project', second.pageInfo.previousCursor);
  assert.equal(top.pageInfo.pageIndex, 0);
  assert.deepEqual(ids(top).slice(0, 2), ['p-06', 'p-new'], '更新与新建的会话都出现在第一页顶部');
  const union = [...ids(top), ...ids(second)];
  assert.equal(new Set(union).size, union.length, '相邻两页不出现重复会话');
  assert.ok(!union.includes('p-05'));
  // A fresh walk from the first page still reaches every remaining Conversation exactly once.
  const walked = [];
  for (let page = await f.page('project'); ; page = await f.page('project', page.pageInfo.nextCursor)) {
    walked.push(...ids(page));
    if (!page.pageInfo.nextCursor) break;
  }
  assert.equal(walked.length, 13);
  assert.equal(new Set(walked).size, 13);
  assert.ok(walked.includes('p-new') && !walked.includes('p-05'));
});

test('锚定页被删空时逐页回退到仍有内容的页，而不是停在空页', async (t) => {
  const f = await fixture(t);
  const first = await f.page('project');
  const second = await f.page('project', first.pageInfo.nextCursor);
  const third = await f.page('project', second.pageInfo.nextCursor);
  assert.deepEqual(ids(third), ['p-03', 'p-02', 'p-01']);
  await f.remove(['p-03', 'p-02', 'p-01']);
  const refreshed = await f.page('project', second.pageInfo.nextCursor);
  assert.equal(refreshed.pageInfo.pageIndex, 1);
  assert.deepEqual(ids(refreshed), ['p-08', 'p-07', 'p-06', 'p-05', 'p-04']);
  assert.equal(refreshed.pageInfo.hasNext, false);
  assert.equal(refreshed.pageInfo.total, 10);
});

test('all 与 unbound 按各自真实范围响应变化且同样不重置分页', async (t) => {
  const f = await fixture(t);
  const allFirst = await f.page('all');
  const allSecond = await f.page('all', allFirst.pageInfo.nextCursor);
  const unboundFirst = await f.page('unbound');
  assert.deepEqual(ids(unboundFirst), ['u-10', 'u-05']);

  await f.create('q-late', Q);
  const allTop = await f.page('all');
  assert.equal(ids(allTop)[0], 'q-late', '全部历史响应其他项目的新会话');
  assert.equal(allTop.pageInfo.total, allFirst.pageInfo.total + 1);
  const allSecondAgain = await f.page('all', allFirst.pageInfo.nextCursor);
  assert.equal(allSecondAgain.pageInfo.pageIndex, 1);
  assert.deepEqual(ids(allSecondAgain), ids(allSecond));

  const unboundAfterForeign = await f.page('unbound');
  assert.deepEqual(ids(unboundAfterForeign), ['u-10', 'u-05'], '未绑定历史不受项目会话影响');
  assert.equal(unboundAfterForeign.pageInfo.cursor, unboundFirst.pageInfo.cursor);
  await f.create('u-late', undefined);
  const unboundAfterOwn = await f.page('unbound');
  assert.deepEqual(ids(unboundAfterOwn), ['u-late', 'u-10', 'u-05']);
  assert.equal(unboundAfterOwn.pageInfo.total, 3);
});

test('游标只绑定数据集身份：换数据集或根代际后从第一页开始，格式错误仍拒绝', async (t) => {
  const f = await fixture(t);
  const first = await f.page('project');
  const decoded = JSON.parse(Buffer.from(first.pageInfo.nextCursor, 'base64url').toString('utf8'));
  const binding = f.root.binding;
  assert.equal(decoded.dataSet, `${binding.dataSetId}:${binding.rootInstanceId}:${binding.rootGeneration}`);
  assert.equal('commitSeq' in decoded, false);
  const foreign = Buffer.from(JSON.stringify({ ...decoded, dataSet: `${binding.dataSetId}:${binding.rootInstanceId}:${binding.rootGeneration + 1}` }), 'utf8')
    .toString('base64url');
  const restarted = await f.page('project', foreign);
  assert.equal(restarted.pageInfo.pageIndex, 0);
  assert.deepEqual(ids(restarted), ids(first));
  const missingDataSet = Buffer.from(JSON.stringify({ ...decoded, dataSet: undefined }), 'utf8').toString('base64url');
  await assert.rejects(f.page('project', missingDataSet), /does not match the requested tree page/);
  await assert.rejects(f.page('unbound', first.pageInfo.nextCursor), /does not match the requested tree page/);
});

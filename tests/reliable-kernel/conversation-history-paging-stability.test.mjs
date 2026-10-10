import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscodeMock = {
  EventEmitter: class { event = () => {}; },
  Uri: { parse: (text) => ({ toString: () => text }) },
  window: {},
  workspace: {}
};
Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? vscodeMock : originalLoad.call(this, name, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { CONVERSATION_HISTORY_EXACT_OFFSET_ROWS } = require(path.join(compiledRoot, 'backend/reliableKernel/clientProjection.js'));
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiledRoot, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));
const conversations = kernel.DOMAIN_REPOSITORIES.domain('Conversation');
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

const P = 'file:///workspace/project-p';
const Q = 'file:///workspace/project-q';
const PAGE = 5;

/**
 * Drives the real Facade page query against a real Runtime worker. The sidebar refresh path
 * re-sends the cursor of the page it shows; every assertion below compares against the current
 * order read straight from SQLite.
 */
async function openFixture(t, { projectCount = 13, sameTime = false, withForeign = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-paging-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: `history-paging-${path.basename(directory)}` });
  t.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 8, 1) + (sameTime ? 0 : (clock += 1) * 1000)).toISOString();
  const linkSteps = (id, projectUri, at) => projectUri ? [row('ConversationProjectLink', {
    id: `link-${id}`, conversation_id: id, project_context_id: projectUri === P ? 'project-p' : 'project-q',
    role: 'primary', created_at: at, updated_at: at
  })] : [];
  const create = async (id, projectUri) => {
    const at = now();
    await database.transaction([
      row('Conversation', { id, title: id, status: 'active', created_at: at, updated_at: at }),
      ...linkSteps(id, projectUri, at)
    ]);
  };
  const touch = (id) => database.transaction([conversations.update(id, {
    updated_at: new Date(Date.UTC(2026, 8, 2) + (clock += 1) * 1000).toISOString()
  })]);
  const remove = (ids) => database.transaction(ids.map((id) => conversations.delete(id)));
  const at = now();
  await database.transaction([
    row('ProjectContext', { id: 'project-p', kind: 'folder', uri: P, name: 'P', created_at: at, updated_at: at }),
    row('ProjectContext', { id: 'project-q', kind: 'folder', uri: Q, name: 'Q', created_at: at, updated_at: at })
  ]);
  // Interleave projects so every P page boundary also sits between foreign rows.
  for (let index = 1; index <= projectCount; index += 1) {
    await create(`p-${String(index).padStart(2, '0')}`, P);
    if (withForeign && index % 3 === 0) await create(`q-${String(index).padStart(2, '0')}`, Q);
    if (withForeign && index % 5 === 0) await create(`u-${String(index).padStart(2, '0')}`, undefined);
  }
  let projectionCalls = 0;
  const countingDatabase = new Proxy(database, {
    get(target, key) {
      if (key === 'conversationHistoryProjection') {
        return (input) => { projectionCalls += 1; return target.conversationHistoryProjection(input); };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const reveals = [];
  const facade = Object.create(Facade.prototype);
  Object.assign(facade, {
    product: { application: { database: countingDatabase }, configuration: { agents: async () => [] } },
    historyEntries: [],
    originLinks: [],
    historyPreviewByRevisionId: new Map(),
    historyTitleByRevisionId: new Map(),
    historyRevealEmitter: { fire: (target) => reveals.push(target) },
    disposed: false,
    startHydration: async () => undefined
  });
  const page = (scopeKind, cursor, { limit = PAGE, projectFolderUri = scopeKind === 'project' ? P : undefined } = {}) =>
    facade.getConversationHistoryPage({ scopeKind, projectFolderUri, cursor, limit });
  /** The scope's full current order, read directly from SQLite. */
  const order = async (scopeKind) => {
    const scopeSql = scopeKind === 'project'
      ? `EXISTS (SELECT 1 FROM conversation_project_link l JOIN project_context p ON p.id = l.project_context_id
          WHERE l.conversation_id = conversation.id AND l.role = 'primary' AND p.uri = '${P}')`
      : scopeKind === 'unbound'
        ? `NOT EXISTS (SELECT 1 FROM conversation_project_link l WHERE l.conversation_id = conversation.id AND l.role = 'primary')`
        : '1 = 1';
    const native = new (require('better-sqlite3'))(root.binding.paths.databasePath, { readonly: true });
    try {
      return native.prepare(`SELECT id FROM conversation WHERE ${scopeSql} ORDER BY updated_at DESC, id DESC`).all().map((item) => item.id);
    } finally {
      native.close();
    }
  };
  return {
    root, database, facade, create, touch, remove, page, order, reveals,
    calls: () => projectionCalls,
    resetCalls: () => { projectionCalls = 0; }
  };
}

const ids = (page) => page.entries.map((entry) => entry.id);

/** Reads every page of the scope from the first page and returns the pages in order. */
async function walk(f, scopeKind, options = {}) {
  const pages = [];
  for (let page = await f.page(scopeKind, undefined, options); ; page = await f.page(scopeKind, page.pageInfo.nextCursor, options)) {
    pages.push(page);
    if (!page.pageInfo.nextCursor) return pages;
  }
}

/** Every page is exactly its slice of the current order: adjacent pages neither repeat nor skip rows. */
function assertPageIsSlice(page, currentOrder, limit = PAGE) {
  const start = page.pageInfo.pageIndex * limit;
  assert.deepEqual(ids(page), currentOrder.slice(start, start + limit), `第 ${page.pageInfo.pageIndex + 1} 页必须是当前排序的对应切片`);
  assert.equal(page.pageInfo.total, currentOrder.length);
  assert.equal(page.pageInfo.hasPrevious, page.pageInfo.pageIndex > 0);
  assert.equal(page.pageInfo.hasNext, start + limit < currentOrder.length);
}

async function assertPartition(f, scopeKind, options = {}) {
  const currentOrder = await f.order(scopeKind);
  const pages = await walk(f, scopeKind, options);
  pages.forEach((page, index) => {
    assert.equal(page.pageInfo.pageIndex, index);
    assertPageIsSlice(page, currentOrder, options.limit ?? PAGE);
  });
  assert.deepEqual(pages.flatMap(ids), currentOrder, '各页并集必须完整覆盖当前排序且不重复');
}

test('其他项目连续提交后，本项目当前页的页码、内容与游标都不变', async (t) => {
  const f = await openFixture(t);
  const first = await f.page('project');
  assert.deepEqual(ids(first), ['p-13', 'p-12', 'p-11', 'p-10', 'p-09']);
  const second = await f.page('project', first.pageInfo.nextCursor);
  assert.deepEqual(ids(second), ['p-08', 'p-07', 'p-06', 'p-05', 'p-04']);

  for (let index = 0; index < 20; index += 1) {
    if (index % 2 === 0) await f.touch(`q-${String(3 * (1 + (index % 4))).padStart(2, '0')}`);
    else await f.create(`q-extra-${index}`, Q);
  }
  // Exactly what SidebarEntryView re-sends: the cursor the backend returned for the shown page.
  const refreshed = await f.page('project', second.pageInfo.cursor);
  assert.equal(refreshed.pageInfo.pageIndex, 1, '无关项目提交不得改变页码');
  assert.deepEqual(ids(refreshed), ids(second));
  assert.equal(refreshed.pageInfo.cursor, second.pageInfo.cursor, '同一页的游标跨提交保持稳定');
  assert.equal(refreshed.pageInfo.previousCursor, second.pageInfo.previousCursor);
  assert.equal(refreshed.pageInfo.nextCursor, second.pageInfo.nextCursor);
  await assertPartition(f, 'project');
});

test('本项目更新与新建后按页码重新定位：原边界行不丢失，各页仍是当前排序的划分', async (t) => {
  const f = await openFixture(t);
  const first = await f.page('project');
  const second = await f.page('project', first.pageInfo.nextCursor);
  // Background activity (not this window's own input): p-06 on page 2 rises to the top and a new
  // Conversation arrives, pushing old boundary rows p-09 and p-10 down into page 2.
  await f.touch('p-06');
  await f.create('p-new', P);
  const refreshed = await f.page('project', second.pageInfo.cursor);
  assert.equal(refreshed.pageInfo.pageIndex, 1);
  assert.deepEqual(ids(refreshed), ['p-10', 'p-09', 'p-08', 'p-07', 'p-05'], '被挤出第一页的边界行出现在第二页');
  const back = await f.page('project', refreshed.pageInfo.previousCursor);
  assert.deepEqual(ids(back), ['p-06', 'p-new', 'p-13', 'p-12', 'p-11']);
  assertPageIsSlice(back, await f.order('project'));
  assertPageIsSlice(refreshed, await f.order('project'));
  await assertPartition(f, 'project');
});

test('前一页有删除时当前页前移补位，"上一页"与当前页不重复', async (t) => {
  const f = await openFixture(t);
  const first = await f.page('project');
  const second = await f.page('project', first.pageInfo.nextCursor);
  await f.remove(['p-13', 'p-12']);
  const refreshed = await f.page('project', second.pageInfo.cursor);
  assert.deepEqual(ids(refreshed), ['p-06', 'p-05', 'p-04', 'p-03', 'p-02']);
  const back = await f.page('project', refreshed.pageInfo.previousCursor);
  assert.deepEqual(ids(back), ['p-11', 'p-10', 'p-09', 'p-08', 'p-07']);
  assert.equal(ids(back).filter((id) => ids(refreshed).includes(id)).length, 0);
  await assertPartition(f, 'project');

  // Once everything fits on one page, the stale page-2 cursor resolves to the only page.
  await f.remove(['p-11', 'p-10', 'p-09', 'p-08', 'p-07', 'p-06']);
  const collapsed = await f.page('project', second.pageInfo.cursor);
  assert.equal(collapsed.pageInfo.pageIndex, 0);
  assert.equal(collapsed.pageInfo.hasPrevious, false);
  assert.deepEqual(ids(collapsed), ['p-05', 'p-04', 'p-03', 'p-02', 'p-01']);
});

test('页被删空或页码越界时一次读取就落到最后一页，工作量与客户端输入无关', async (t) => {
  const f = await openFixture(t);
  const first = await f.page('project');
  const second = await f.page('project', first.pageInfo.nextCursor);
  const third = await f.page('project', second.pageInfo.nextCursor);
  assert.deepEqual(ids(third), ['p-03', 'p-02', 'p-01']);
  await f.remove(['p-03', 'p-02', 'p-01', 'p-04', 'p-05', 'p-06', 'p-07']);
  f.resetCalls();
  const clamped = await f.page('project', third.pageInfo.cursor);
  assert.equal(f.calls(), 1, '被删空的页只需一次投影读取');
  assert.equal(clamped.pageInfo.pageIndex, 1);
  assert.deepEqual(ids(clamped), ['p-08']);
  assert.equal(clamped.pageInfo.hasNext, false);

  const decoded = JSON.parse(Buffer.from(third.pageInfo.cursor, 'base64url').toString('utf8'));
  const oldKey = { updatedAt: '1970-01-01T00:00:00.000Z', id: 'x' };
  const forged = Buffer.from(JSON.stringify({
    ...decoded,
    pageIndex: Number.MAX_SAFE_INTEGER,
    boundary: { kind: 'after', ...oldKey },
    trail: Array.from({ length: 2000 }, () => oldKey)
  }), 'utf8').toString('base64url');
  f.resetCalls();
  const forgedPage = await f.page('project', forged);
  assert.equal(f.calls(), 1, '伪造的超大页码或附带数据不会放大读取次数');
  assert.equal(forgedPage.pageInfo.pageIndex, 1);
  assert.deepEqual(ids(forgedPage), ['p-08']);
});

test('updated_at 全部相同时按 id 划分，逐页翻完不漏不重', async (t) => {
  const f = await openFixture(t, { projectCount: 12, sameTime: true, withForeign: false });
  await assertPartition(f, 'project');
  await assertPartition(f, 'all');
});

test('锚点会话本身被删除或被更新后，当前页仍是当前排序的对应切片', async (t) => {
  const f = await openFixture(t);
  const first = await f.page('project');
  const second = await f.page('project', first.pageInfo.nextCursor);
  await f.remove(['p-09']);
  const afterDelete = await f.page('project', second.pageInfo.cursor);
  assertPageIsSlice(afterDelete, await f.order('project'));
  assert.deepEqual(ids(afterDelete), ['p-07', 'p-06', 'p-05', 'p-04', 'p-03']);
  await f.touch('p-08');
  const afterUpdate = await f.page('project', afterDelete.pageInfo.cursor);
  assertPageIsSlice(afterUpdate, await f.order('project'));
  await assertPartition(f, 'project');
});

test('all 与 unbound 按各自真实范围响应变化，各页始终是当前排序的划分', async (t) => {
  const f = await openFixture(t);
  const allFirst = await f.page('all');
  const allSecond = await f.page('all', allFirst.pageInfo.nextCursor);
  const unboundFirst = await f.page('unbound');
  assert.deepEqual(ids(unboundFirst), ['u-10', 'u-05']);

  await f.create('q-late', Q);
  const allTop = await f.page('all');
  assert.equal(ids(allTop)[0], 'q-late', '全部历史响应其他项目的新会话');
  const allSecondAgain = await f.page('all', allSecond.pageInfo.cursor);
  assert.equal(allSecondAgain.pageInfo.pageIndex, 1);
  assertPageIsSlice(allSecondAgain, await f.order('all'));
  await assertPartition(f, 'all');

  const unboundAfterForeign = await f.page('unbound', unboundFirst.pageInfo.cursor);
  assert.deepEqual(ids(unboundAfterForeign), ['u-10', 'u-05'], '未绑定历史不受项目会话影响');
  assert.equal(unboundAfterForeign.pageInfo.cursor, unboundFirst.pageInfo.cursor);
  await f.create('u-late', undefined);
  assert.deepEqual(ids(await f.page('unbound', unboundFirst.pageInfo.cursor)), ['u-late', 'u-10', 'u-05']);
  await assertPartition(f, 'unbound');
});

test('游标绑定真实数据集身份：换到另一个真实根后从第一页开始，格式错误与旧格式仍拒绝', async (t) => {
  const f = await openFixture(t);
  const other = await openFixture(t, { projectCount: 7, withForeign: false });
  assert.notEqual(other.root.binding.dataSetId, f.root.binding.dataSetId);
  const first = await f.page('project');
  const second = await f.page('project', first.pageInfo.nextCursor);
  const moved = await other.page('project', second.pageInfo.cursor);
  assert.equal(moved.pageInfo.pageIndex, 0, '另一个数据集的游标从第一页开始');
  assert.deepEqual(ids(moved), ['p-07', 'p-06', 'p-05', 'p-04', 'p-03']);

  const decoded = JSON.parse(Buffer.from(second.pageInfo.cursor, 'base64url').toString('utf8'));
  const binding = f.root.binding;
  assert.equal(decoded.dataSet, `${binding.dataSetId}:${binding.rootInstanceId}:${binding.rootGeneration}`);
  assert.equal(decoded.pageIndex, 1);
  assert.equal('commitSeq' in decoded || 'trail' in decoded || 'anchor' in decoded, false);
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const nextGeneration = encode({ ...decoded, dataSet: `${binding.dataSetId}:${binding.rootInstanceId}:${binding.rootGeneration + 1}` });
  assert.equal((await f.page('project', nextGeneration)).pageInfo.pageIndex, 0);
  await assert.rejects(f.page('project', encode({ ...decoded, dataSet: undefined })), /does not match the requested tree page/);
  await assert.rejects(f.page('project', encode({ ...decoded, pageIndex: -1 })), /does not match the requested tree page/);
  await assert.rejects(f.page('project', encode({ ...decoded, boundary: { kind: 'sideways', updatedAt: 'x', id: 'y' } })), /boundary is malformed/);
  await assert.rejects(f.page('project', encode({
    kind: 'conversation-history-keyset-page', scopeKey: decoded.scopeKey, pageSize: PAGE,
    dataSet: decoded.dataSet, anchor: null, trail: []
  })), /does not match the requested tree page/);
  await assert.rejects(f.page('project', 'not-base64-json'), /malformed/);
  await assert.rejects(f.page('unbound', second.pageInfo.cursor), /does not match the requested tree page/);
});

test('本窗口发起的动作按会话所属项目通知侧栏回到第一页', async (t) => {
  const f = await openFixture(t);
  await f.facade.revealConversationHistoryTop('p-03');
  await f.facade.revealConversationHistoryTop('q-06');
  await f.facade.revealConversationHistoryTop('u-05');
  assert.deepEqual(f.reveals, [
    { conversationId: 'p-03', projectFolderUri: P },
    { conversationId: 'q-06', projectFolderUri: Q },
    { conversationId: 'u-05' }
  ]);
});

test('超出精确页码窗口的深页按键集边界读取，最后一页从末尾精确读取，读取量有界', async (t) => {
  const f = await openFixture(t, { projectCount: 0, withForeign: false });
  const LIMIT = 200;
  const total = CONVERSATION_HISTORY_EXACT_OFFSET_ROWS + 450;
  const at = (index) => new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString();
  for (let start = 0; start < total; start += 1000) {
    await f.database.transaction(Array.from({ length: Math.min(1000, total - start) }, (_value, offset) => {
      const index = start + offset;
      const id = `deep-${String(index).padStart(6, '0')}`;
      return row('Conversation', { id, title: id, status: 'active', created_at: at(index), updated_at: at(index) });
    }));
  }
  const currentOrder = await f.order('all');
  const lastPageIndex = Math.floor((total - 1) / LIMIT);
  const exactWindowPage = Math.floor(CONVERSATION_HISTORY_EXACT_OFFSET_ROWS / LIMIT);
  assert.equal(lastPageIndex, exactWindowPage + 2, '夹具需要恰好一张位于窗口外、又不是最后一页的深页');

  const pages = await walk(f, 'all', { limit: LIMIT });
  assert.equal(pages.length, lastPageIndex + 1);
  pages.forEach((page) => assertPageIsSlice(page, currentOrder, LIMIT));
  assert.deepEqual(pages.flatMap(ids), currentOrder);

  const deep = pages[exactWindowPage + 1];
  const refreshed = await f.page('all', deep.pageInfo.cursor, { limit: LIMIT });
  assert.equal(refreshed.pageInfo.pageIndex, exactWindowPage + 1);
  assert.deepEqual(ids(refreshed), ids(deep));
  const back = await f.page('all', pages[lastPageIndex].pageInfo.previousCursor, { limit: LIMIT });
  assert.deepEqual(ids(back), ids(deep), '从最后一页返回深页得到同一切片');
  const decoded = JSON.parse(Buffer.from(deep.pageInfo.cursor, 'base64url').toString('utf8'));
  f.resetCalls();
  const overflow = await f.page('all', Buffer.from(JSON.stringify({ ...decoded, pageIndex: 1e9 }), 'utf8').toString('base64url'), { limit: LIMIT });
  assert.equal(f.calls(), 1);
  assert.equal(overflow.pageInfo.pageIndex, lastPageIndex);
  assert.deepEqual(ids(overflow), currentOrder.slice(lastPageIndex * LIMIT));
});

const workspaceFolder = (uri, index) => ({ uri: { toString: () => uri }, name: uri.split('/').pop(), index });

/** Drives the real Facade's current-project resolution with the vscode boundary replaced. */
function projectResolutionFixture({ folders = [], activeEditorUri = null, remembered, writes = [], stored = {} } = {}) {
  const facade = Object.create(Facade.prototype);
  const listeners = [];
  Object.assign(facade, {
    lastActiveProjectFolderUri: remembered,
    context: { workspaceState: {
      get: (key) => stored[key],
      update: (key, value) => { writes.push({ key, value }); return Promise.resolve(); }
    } }
  });
  vscodeMock.window.activeTextEditor = activeEditorUri === null ? undefined : { document: { uri: { toString: () => activeEditorUri } } };
  vscodeMock.window.onDidChangeActiveTextEditor = (listener) => { listeners.push(listener); return { dispose() {} }; };
  vscodeMock.workspace.workspaceFolders = folders;
  vscodeMock.workspace.getWorkspaceFolder = (uri) => folders.find((folder) => folder.uri.toString() === uri.toString());
  return { facade, writes, listeners };
}

test('多根工作区没有活动编辑器时当前项目沿用最近编辑过的文件夹', () => {
  const { facade } = projectResolutionFixture({ folders: [workspaceFolder(P, 0), workspaceFolder(Q, 1)], remembered: P });
  assert.deepEqual(facade.getCurrentProjectHistoryScope(), { kind: 'project', folderUri: P });
});

test('活动编辑器所在文件夹优先于记住的文件夹', () => {
  const { facade } = projectResolutionFixture({ folders: [workspaceFolder(P, 0), workspaceFolder(Q, 1)], activeEditorUri: Q, remembered: P });
  assert.deepEqual(facade.getCurrentProjectHistoryScope(), { kind: 'project', folderUri: Q });
});

test('单根工作区没有记忆时当前项目仍解析到唯一文件夹', () => {
  const { facade } = projectResolutionFixture({ folders: [workspaceFolder(P, 0)] });
  assert.deepEqual(facade.getCurrentProjectHistoryScope(), { kind: 'project', folderUri: P });
});

test('单根工作区忽略过期的记忆，当前项目仍解析到唯一文件夹', () => {
  const { facade } = projectResolutionFixture({ folders: [workspaceFolder(Q, 0)], remembered: P });
  assert.deepEqual(facade.getCurrentProjectHistoryScope(), { kind: 'project', folderUri: Q });
});

test('记住的文件夹已不在工作区时当前项目回落到全部历史', () => {
  const { facade } = projectResolutionFixture({ folders: [workspaceFolder(P, 0), workspaceFolder(Q, 1)], remembered: 'file:///workspace/project-removed' });
  assert.deepEqual(facade.getCurrentProjectHistoryScope(), { kind: 'all' });
});

test('多根工作区新建对话未指定项目时使用当前项目解析结果', () => {
  const folders = [workspaceFolder(P, 0), workspaceFolder(Q, 1)];
  const { facade } = projectResolutionFixture({ folders, remembered: Q });
  assert.equal(facade.resolveProjectFolderForNewConversation(), folders[1]);
});

test('新建对话显式指定的项目仍必须属于当前工作区', () => {
  const folders = [workspaceFolder(P, 0), workspaceFolder(Q, 1)];
  const { facade } = projectResolutionFixture({ folders, remembered: Q });
  assert.equal(facade.resolveProjectFolderForNewConversation(Q), folders[1]);
  assert.throws(() => facade.resolveProjectFolderForNewConversation('file:///workspace/project-x'), /不属于当前 VS Code 工作区/);
});

test('活动编辑器切换时记住所在文件夹并持久化，工作区外或未变化时不重复写入', () => {
  const folders = [workspaceFolder(P, 0), workspaceFolder(Q, 1)];
  const { facade, writes } = projectResolutionFixture({ folders, remembered: P, activeEditorUri: Q });
  facade.rememberActiveProjectFolder();
  facade.rememberActiveProjectFolder();
  vscodeMock.window.activeTextEditor = { document: { uri: { toString: () => 'file:///outside/notes.md' } } };
  facade.rememberActiveProjectFolder();
  assert.equal(facade.lastActiveProjectFolderUri, Q);
  assert.deepEqual(writes, [{ key: 'limcode.lastActiveProjectFolderUri', value: Q }]);
});

test('工厂启动跟踪时读取记住的文件夹并订阅活动编辑器切换，切换后记忆随之更新', () => {
  const folders = [workspaceFolder(P, 0), workspaceFolder(Q, 1)];
  const { facade, writes, listeners } = projectResolutionFixture({ folders, stored: { 'limcode.lastActiveProjectFolderUri': P } });
  facade.trackActiveProjectFolder();
  assert.deepEqual(facade.getCurrentProjectHistoryScope(), { kind: 'project', folderUri: P });
  assert.equal(listeners.length, 1);
  vscodeMock.window.activeTextEditor = { document: { uri: { toString: () => Q } } };
  listeners[0]();
  vscodeMock.window.activeTextEditor = undefined;
  assert.deepEqual(facade.getCurrentProjectHistoryScope(), { kind: 'project', folderUri: Q });
  assert.deepEqual(writes, [{ key: 'limcode.lastActiveProjectFolderUri', value: Q }]);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

const root = process.cwd();

async function createWebviewTestServer() {
  return createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error'
  });
}

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/**
 * 侧边栏折叠意图保持测试。
 *
 * 断言对象是生产模块 webview/src/sidebar/collapseIntent.ts 的真实导出函数，该模块同时被
 * SidebarApp.vue 使用。测试不复制侧边栏实现，只提供树与状态输入。
 */

test('用户折叠后新运行子 Agent 不重新展开该父节点', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());

  const { buildConversationHistoryForest, flattenConversationHistoryForest } =
    await server.ssrLoadModule('@shared/conversationHistoryTree');
  const collapseIntent = await server.ssrLoadModule('/src/sidebar/collapseIntent.ts');

  const forest = buildConversationHistoryForest(
    [
      entry('conv-root', 1000),
      entry('conv-child-1', 1001),
      { ...entry('conv-child-2', 1002), isRunning: true, runState: 'running' }
    ],
    [
      originLink('link-1', 'conv-child-1', 'conv-root', 950),
      originLink('link-2', 'conv-child-2', 'conv-root', 980)
    ]
  );

  const result = collapseIntent.expandNewlyActiveAgentAncestors({
    nodes: flattenConversationHistoryForest(forest),
    expandedIds: new Set(),
    userCollapsedIds: new Set(['conv-root']),
    previouslyActiveAgentIds: new Set()
  });

  assert.equal(result.expandedIds.has('conv-root'), false,
    '用户显式折叠的父节点不应被新运行子 Agent 自动展开');
  assert.equal(result.changed, false);

  const visible = collapseIntent.flattenVisibleHistoryNodes({
    forest,
    expandedIds: result.expandedIds,
    maxVisualDepth: 8
  });
  assert.deepEqual(visible.map((node) => node.entry.id), ['conv-root']);
  assert.equal(visible[0].expanded, false);
  assert.equal(visible[0].hasChildren, true);
  assert.equal(visible[0].descendantAgents.running, 1, '折叠节点仍需显示运行中子 Agent 汇总');
});

test('无显式折叠标记时新运行子 Agent 仍自动展开其祖先', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());

  const { buildConversationHistoryForest, flattenConversationHistoryForest } =
    await server.ssrLoadModule('@shared/conversationHistoryTree');
  const collapseIntent = await server.ssrLoadModule('/src/sidebar/collapseIntent.ts');

  const forest = buildConversationHistoryForest(
    [entry('conv-root', 1000), { ...entry('conv-child', 1001), isRunning: true, runState: 'running' }],
    [originLink('link-1', 'conv-child', 'conv-root', 950)]
  );

  const result = collapseIntent.expandNewlyActiveAgentAncestors({
    nodes: flattenConversationHistoryForest(forest),
    expandedIds: new Set(),
    userCollapsedIds: new Set(),
    previouslyActiveAgentIds: new Set()
  });

  assert.equal(result.expandedIds.has('conv-root'), true, '未被用户折叠的祖先应保持原有自动展开行为');
  assert.equal(result.changed, true);
});

test('用户主动展开后清除折叠标记，其祖先可再次自动展开', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());

  const { buildConversationHistoryForest, flattenConversationHistoryForest } =
    await server.ssrLoadModule('@shared/conversationHistoryTree');
  const collapseIntent = await server.ssrLoadModule('/src/sidebar/collapseIntent.ts');

  const forest = buildConversationHistoryForest(
    [entry('conv-parent', 1000), { ...entry('conv-agent', 1001), isRunning: true, runState: 'running' }],
    [originLink('link-1', 'conv-agent', 'conv-parent', 950)]
  );

  const collapsed = collapseIntent.toggleHistoryNode({
    conversationId: 'conv-parent',
    expandedIds: new Set(['conv-parent']),
    userCollapsedIds: new Set()
  });
  assert.equal(collapsed.userCollapsedIds.has('conv-parent'), true, '用户折叠应记录显式折叠意图');

  const expandedAgain = collapseIntent.toggleHistoryNode({
    conversationId: 'conv-parent',
    expandedIds: collapsed.expandedIds,
    userCollapsedIds: collapsed.userCollapsedIds
  });
  assert.equal(expandedAgain.expandedIds.has('conv-parent'), true, '用户展开应恢复展开状态');
  assert.equal(expandedAgain.userCollapsedIds.has('conv-parent'), false, '用户展开应清除折叠标记');

  const autoExpanded = collapseIntent.expandNewlyActiveAgentAncestors({
    nodes: flattenConversationHistoryForest(forest),
    expandedIds: expandedAgain.expandedIds,
    userCollapsedIds: expandedAgain.userCollapsedIds,
    previouslyActiveAgentIds: new Set()
  });
  assert.equal(autoExpanded.expandedIds.has('conv-parent'), true);
});

test('无持久化展开记录且全部静止时默认折叠', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());

  const { buildConversationHistoryForest } =
    await server.ssrLoadModule('@shared/conversationHistoryTree');
  const collapseIntent = await server.ssrLoadModule('/src/sidebar/collapseIntent.ts');

  const forest = buildConversationHistoryForest(
    [entry('conv-quiet', 1000), entry('conv-child', 1001)],
    [originLink('link-1', 'conv-child', 'conv-quiet', 950)]
  );

  const expandedIds = new Set(Object.keys({}));
  const visible = collapseIntent.flattenVisibleHistoryNodes({
    forest,
    expandedIds,
    maxVisualDepth: 8
  });

  assert.equal(visible.length, 1, '没有展开记录时子节点不应渲染');
  assert.equal(visible[0].entry.id, 'conv-quiet');
  assert.equal(visible[0].expanded, false, '默认应为折叠，而不是默认全部展开');
});

test('用户折叠后激活后代会话仍保持折叠', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());

  const { buildConversationHistoryForest, flattenConversationHistoryForest } =
    await server.ssrLoadModule('@shared/conversationHistoryTree');
  const collapseIntent = await server.ssrLoadModule('/src/sidebar/collapseIntent.ts');

  const forest = buildConversationHistoryForest(
    [entry('conv-main', 1000), entry('conv-branch', 1001)],
    [originLink('link-1', 'conv-branch', 'conv-main', 950)]
  );

  const result = collapseIntent.expandActiveConversationAncestors({
    nodes: flattenConversationHistoryForest(forest),
    activeConversationId: 'conv-branch',
    expandedIds: new Set(),
    userCollapsedIds: new Set(['conv-main'])
  });

  assert.equal(result.expandedIds.has('conv-main'), false,
    '激活子会话不应重新展开被用户显式折叠的祖先');
  assert.equal(result.changed, false);
});

test('折叠标记与收藏状态互相保留，并容忍缺失新字段', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());

  const collapseIntent = await server.ssrLoadModule('/src/sidebar/collapseIntent.ts');

  const existing = {
    expandedConversationIds: ['conv-a'],
    favoriteConversationIds: ['conv-fav']
  };
  const withCollapsed = collapseIntent.mergeSidebarHostState(existing, {
    expandedConversationIds: ['conv-a'],
    userCollapsedConversationIds: new Set(['conv-b'])
  });
  assert.deepEqual(withCollapsed.expandedConversationIds, ['conv-a']);
  assert.deepEqual(withCollapsed.favoriteConversationIds, ['conv-fav'], '写展开状态必须保留收藏');
  assert.deepEqual([...withCollapsed.userCollapsedConversationIds], ['conv-b']);

  const favoriteOnly = collapseIntent.mergeSidebarHostState(withCollapsed, {
    favoriteConversationIds: ['conv-fav', 'conv-new']
  });
  assert.deepEqual([...favoriteOnly.userCollapsedConversationIds], ['conv-b'], '写收藏必须保留折叠意图');

  const legacy = collapseIntent.userCollapsedIdsFromState({ expandedConversationIds: ['conv-a'] });
  assert.deepEqual([...legacy], [], '缺少新字段时按空数组处理');
});

function entry(id, updatedAt) {
  return {
    id,
    title: id,
    isRunning: false,
    status: 'final',
    messageCount: 1,
    createdAt: updatedAt - 100,
    updatedAt,
    previewState: 'ready',
    preview: 'preview'
  };
}

function originLink(id, conversationId, parentConversationId, createdAt) {
  return {
    id,
    conversationId,
    sourceConversationId: parentConversationId,
    originKind: 'agent',
    sourceKind: 'explicit',
    createdAt
  };
}

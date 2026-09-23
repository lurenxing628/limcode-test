import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompressionRebuildPreviewResultPayload } from '../../shared/protocol.ts';
import { summaryRebuildPreviewView } from '../src/components/input/summaryRebuildPreview.ts';

const estimate = { sourceTokens: 123_400, summaryCount: 2, contextWindowTokens: 200_000, inputCapacityTokens: 184_000 };
const loaded = (result: Omit<CompressionRebuildPreviewResultPayload, 'conversationId' | 'rootId'>) => ({
  status: 'loaded' as const,
  result: { conversationId: 'conversation', rootId: 'root', ...result }
});
const rowValue = (rows: Array<{ label: string; value: string }>, label: string) => rows.find((row) => row.label === label)?.value;

test('estimating: the dialog says it is estimating and cannot be confirmed yet', () => {
  for (const state of [undefined, { status: 'loading' as const }]) {
    const view = summaryRebuildPreviewView(state);
    assert.equal(view.canConfirm, false);
    assert.equal(view.rows.length, 0);
    assert.match(view.notice ?? '', /正在估算/);
  }
});

test('fits: shows the estimated size, the window and the number of requests', () => {
  const view = summaryRebuildPreviewView(loaded({ estimate, outcome: {
    kind: 'ready', methodKind: 'segmented_summary', providerRequests: 6, summaryRequests: 5, mergeRequests: 1, attachmentRequests: 0
  } }));
  assert.equal(view.canConfirm, true);
  assert.equal(view.notice, undefined);
  assert.equal(rowValue(view.rows, '原始记录'), '约 123.4k tokens（本地估算）');
  assert.equal(rowValue(view.rows, '要展开的摘要'), '2 份');
  assert.equal(rowValue(view.rows, '压缩模型窗口'), '200k tokens');
  assert.equal(rowValue(view.rows, '预计请求'), '约 6 次（分 5 段总结，合并 1 次）');

  const single = summaryRebuildPreviewView(loaded({ estimate: { ...estimate, summaryCount: 0 }, outcome: {
    kind: 'ready', methodKind: 'llm_summary', providerRequests: 3, summaryRequests: 1, mergeRequests: 0, attachmentRequests: 2
  } }));
  assert.equal(rowValue(single.rows, '要展开的摘要'), undefined);
  assert.equal(rowValue(single.rows, '预计请求'), '3 次（一次总结，分析附件 2 次）');

  const local = summaryRebuildPreviewView(loaded({ estimate, outcome: {
    kind: 'ready', methodKind: 'deterministic_summary', providerRequests: 0, summaryRequests: 0, mergeRequests: 0, attachmentRequests: 0
  } }));
  assert.equal(rowValue(local.rows, '预计请求'), '不调用模型（本地机械摘要）');
  assert.equal(local.canConfirm, true);
});

test('over the limit: says plainly why it cannot be done and blocks confirmation', () => {
  const cases: Array<[CompressionRebuildPreviewResultPayload['outcome'], RegExp]> = [
    [{ kind: 'blocked', reason: 'leaf_budget_exceeded', leafRequestLimit: 32 }, /超过 32 段/],
    [{ kind: 'blocked', reason: 'no_chunking_method' }, /不能分段/],
    [{ kind: 'blocked', reason: 'request_too_large' }, /窗口太小/],
    [{ kind: 'blocked', reason: 'compression_disabled' }, /压缩已关闭/],
    [{ kind: 'blocked', reason: 'replay_limit_exceeded', replayLimit: { kind: 'bytes', value: 64 * 1024 * 1024 } }, /64 MB/],
    [{ kind: 'blocked', reason: 'replay_limit_exceeded', replayLimit: { kind: 'segments', value: 32768 } }, /32768 条/],
    [{ kind: 'blocked', reason: 'replay_limit_exceeded', replayLimit: { kind: 'depth', value: 64 } }, /64 层/],
    [{ kind: 'stale' }, /已经变了/]
  ];
  for (const [outcome, pattern] of cases) {
    const view = summaryRebuildPreviewView(loaded({ ...(outcome.kind === 'blocked' && outcome.reason !== 'replay_limit_exceeded' ? { estimate } : {}), outcome }));
    assert.equal(view.canConfirm, false, JSON.stringify(outcome));
    assert.equal(view.tone, 'blocked');
    assert.match(view.notice ?? '', pattern);
    if (outcome.kind === 'blocked' && outcome.reason !== 'compression_disabled' && outcome.reason !== 'replay_limit_exceeded') {
      assert.match(view.notice ?? '', /^无法重建：/);
    }
  }
});

test('estimate failed: shows the reason and still lets the user decide', () => {
  const failed = summaryRebuildPreviewView(loaded({ outcome: { kind: 'error', message: '来源缺失。' } }));
  assert.equal(failed.canConfirm, true);
  assert.equal(failed.tone, 'unknown');
  assert.equal(failed.notice, '暂时无法估算：来源缺失。仍可重建，但可能失败或消耗大量 token。');
  const bridgeFailure = summaryRebuildPreviewView({ status: 'failed', message: '' });
  assert.equal(bridgeFailure.notice, '暂时无法估算。仍可重建，但可能失败或消耗大量 token。');
});

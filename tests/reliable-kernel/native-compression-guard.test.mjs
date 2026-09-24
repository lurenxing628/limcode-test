import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = {
  Uri,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: { fs: {} }
};
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const {
  collectNativeConfigurationUpdates,
  collectStoredNativeConfigurationUpdates,
  isNativeConfigurationUpdatePart,
  projectStoredModelFacingWindow,
  projectSummaryModelWindow,
  stripNativeConfigurationUpdates
} = require('../../dist/extension/backend/reliableKernel/modelFacingContextProjection.js');
const {
  evaluateNativeCompressionGuard,
  planNativeCompressionRebase,
  selectBlockingNativePendingCalls
} = require('../../dist/extension/backend/reliableKernel/nativeCompressionGuard.js');
const {
  estimateToolPairContentTokens,
  nativePromptCalibration
} = require('../../dist/extension/backend/reliableKernel/contextTokenEstimator.js');
const {
  estimateMessageContentsTokens
} = require('../../dist/extension/backend/reliableKernel/modelTokenEstimator.js');

function updatePart(effort) {
  return {
    providerContext: {
      provider: 'openai',
      format: 'openai-responses',
      endpoint: 'responses',
      itemType: 'configuration_update',
      rawItem: { type: 'configuration_update', reasoning: { effort } }
    }
  };
}

function updateCarrier(effort) {
  return { role: 'user', parts: [updatePart(effort)] };
}

function pendingCall(overrides = {}) {
  return {
    toolCallId: 'call-1',
    toolName: 'read_file',
    turnId: 'turn-1',
    callContextSegmentId: 'seg-call-1',
    settled: false,
    delivered: false,
    ...overrides
  };
}

test('stripNativeConfigurationUpdates只丢弃传输层更新项并保持语义顺序与原数组不变', () => {
  const input = [
    { role: 'user', parts: [{ text: '第一段' }] },
    updateCarrier('high'),
    { role: 'model', parts: [{ text: '回答' }] },
    { role: 'user', parts: [{ text: '补充' }, updatePart('low')] },
    { role: 'user', parts: [{ text: '结尾' }] }
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const stripped = stripNativeConfigurationUpdates(input);
  assert.equal(stripped.removedCount, 2);
  assert.deepEqual(stripped.updates, [{ effort: 'high' }, { effort: 'low' }]);
  // 更新独占载体整体消失；混合载体保留其余部分；其余内容位置不变。
  assert.deepEqual(
    stripped.contents.map((content) => ({ role: content.role, parts: content.parts.length })),
    [
      { role: 'user', parts: 1 },
      { role: 'model', parts: 1 },
      { role: 'user', parts: 1 },
      { role: 'user', parts: 1 }
    ]
  );
  assert.equal(stripped.contents[2].parts[0].text, '补充');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
});

test('configuration_update检测同时覆盖itemType与rawItem.type两种表示', () => {
  const byItemType = updatePart('medium');
  const byRawType = {
    providerContext: { provider: 'openai', format: 'openai-responses', rawItem: { type: 'configuration_update', reasoning: { effort: 'xhigh' } } }
  };
  assert.equal(isNativeConfigurationUpdatePart(byItemType), true);
  assert.equal(isNativeConfigurationUpdatePart(byRawType), true);
  assert.equal(isNativeConfigurationUpdatePart({ text: '普通文本' }), false);
  assert.deepEqual(collectNativeConfigurationUpdates([{ role: 'user', parts: [byRawType] }]), [{ effort: 'xhigh' }]);
});

test('压缩守卫：全窗口原生Compact遇未决调用必须延期', () => {
  const decision = evaluateNativeCompressionGuard({
    fullWindowRequired: true,
    facts: { pendingToolCalls: [pendingCall()], pendingSteeringInputs: 0 },
    orderedSegmentIds: ['s0', 's1', 'seg-call-1', 's3'],
    requestedSourceSegmentCount: 4
  });
  assert.equal(decision.status, 'defer');
  assert.equal(decision.reason, 'native_pending_tools');
  assert.equal(decision.pendingToolCalls, 1);
});

test('压缩守卫：文本压缩源前缀收缩到最老未决调用之前，已在界内则放行', () => {
  const ids = ['s0', 's1', 's2', 's3', 'seg-call-1', 's5', 's6', 's7', 's8', 's9'];
  const protect = evaluateNativeCompressionGuard({
    fullWindowRequired: false,
    facts: { pendingToolCalls: [pendingCall()], pendingSteeringInputs: 0 },
    orderedSegmentIds: ids,
    requestedSourceSegmentCount: 8
  });
  assert.equal(protect.status, 'protect');
  assert.equal(protect.sourceSegmentCount, 4);
  const allow = evaluateNativeCompressionGuard({
    fullWindowRequired: false,
    facts: { pendingToolCalls: [pendingCall()], pendingSteeringInputs: 0 },
    orderedSegmentIds: ids,
    requestedSourceSegmentCount: 3
  });
  assert.equal(allow.status, 'allow');
});

test('压缩守卫：未决调用尚未落段或在窗口起点时保守延期', () => {
  const unappended = evaluateNativeCompressionGuard({
    fullWindowRequired: false,
    facts: { pendingToolCalls: [pendingCall({ callContextSegmentId: undefined, resultContextSegmentId: undefined })], pendingSteeringInputs: 0 },
    orderedSegmentIds: ['s0', 's1'],
    requestedSourceSegmentCount: 1
  });
  assert.equal(unappended.status, 'defer');
  assert.equal(unappended.reason, 'native_pending_tools');
  const atStart = evaluateNativeCompressionGuard({
    fullWindowRequired: false,
    facts: { pendingToolCalls: [pendingCall({ callContextSegmentId: 's0' })], pendingSteeringInputs: 0 },
    orderedSegmentIds: ['s0', 's1', 's2'],
    requestedSourceSegmentCount: 2
  });
  assert.equal(atStart.status, 'defer');
});

test('压缩守卫：只有上下文完全闭合的调用不阻塞；未闭合一律阻塞', () => {
  const blocking = selectBlockingNativePendingCalls([
    // 完全闭合（settled + 结果已入段）：即使投递回执缺失也不阻塞。
    pendingCall({ toolCallId: 'closed', settled: true, delivered: false, resultContextSegmentId: 'seg-result' }),
    // 未settled：结果可能经迟到回执或崩溃后终态闭合并发到达，必须阻塞。
    pendingCall({ toolCallId: 'unsettled', settled: false }),
    // 已settled但结果尚未入段：入段仍可随后发生，必须阻塞。
    pendingCall({ toolCallId: 'no-occurrence', settled: true, resultContextSegmentId: undefined }),
    // 终端轮次的未闭合遗留同样阻塞（终态本身不证明闭合）。
    pendingCall({ toolCallId: 'terminal-unclosed', turnId: 'turn-old', settled: false, delivered: false })
  ]);
  assert.deepEqual(
    blocking.map((call) => call.toolCallId),
    ['unsettled', 'no-occurrence', 'terminal-unclosed']
  );
  const allow = evaluateNativeCompressionGuard({
    fullWindowRequired: true,
    facts: {
      pendingToolCalls: selectBlockingNativePendingCalls([
        pendingCall({ settled: true, delivered: false, resultContextSegmentId: 'seg-result' })
      ]),
      pendingSteeringInputs: 0
    },
    orderedSegmentIds: ['s0'],
    requestedSourceSegmentCount: 1
  });
  assert.equal(allow.status, 'allow');
});

test('压缩守卫：在途转向一律延期且不计入伪造关闭', () => {
  const decision = evaluateNativeCompressionGuard({
    fullWindowRequired: false,
    facts: { pendingToolCalls: [], pendingSteeringInputs: 2 },
    orderedSegmentIds: ['s0', 's1', 's2'],
    requestedSourceSegmentCount: 2
  });
  assert.equal(decision.status, 'defer');
  assert.equal(decision.reason, 'native_steering_in_flight');
  assert.equal(decision.pendingSteeringInputs, 2);
});

test('重放基计划：窗口内更新被丢弃后以最后生效档位生成唯一新鲜更新', () => {
  const plan = planNativeCompressionRebase({
    nativeEnabled: true,
    updates: [{ effort: 'low' }, { effort: 'high' }]
  });
  assert.equal(plan.kind, 'native_full_rebase');
  assert.equal(plan.forceFullReason, 'compression');
  assert.equal(plan.cacheReset, true);
  assert.equal(plan.droppedConfigurationUpdates, 2);
  assert.deepEqual(plan.effectiveReasoning, { effort: 'high' });
  assert.deepEqual(plan.freshConfigurationUpdate, { effort: 'high' });
});

test('重放基计划：保留尾仍携带更新时不再生成相邻的新鲜更新', () => {
  const plan = planNativeCompressionRebase({
    nativeEnabled: true,
    updates: [{ effort: 'low' }],
    retainedUpdates: [{ effort: 'xhigh' }]
  });
  assert.equal(plan.droppedConfigurationUpdates, 1);
  assert.deepEqual(plan.effectiveReasoning, { effort: 'xhigh' });
  assert.equal(plan.freshConfigurationUpdate, undefined);
});

test('重放基计划：冻结档位优先于窗口扫描，非原生不生成计划', () => {
  const frozen = planNativeCompressionRebase({
    nativeEnabled: true,
    updates: [{ effort: 'high' }],
    frozenEffectiveEffort: 'medium'
  });
  assert.deepEqual(frozen.effectiveReasoning, { effort: 'medium' });
  assert.deepEqual(frozen.freshConfigurationUpdate, { effort: 'medium' });
  assert.equal(planNativeCompressionRebase({ nativeEnabled: false, updates: [{ effort: 'high' }] }), undefined);
  const noUpdates = planNativeCompressionRebase({ nativeEnabled: true, updates: [] });
  assert.equal(noUpdates.cacheReset, true);
  assert.equal(noUpdates.freshConfigurationUpdate, undefined);
});

test('仅调用未决段按时间顺序投影为模型functionCall并保留实际async与思考签名', () => {
  const callOnly = JSON.stringify({
    kind: 'tool_pair',
    native: true,
    toolCall: {
      id: 'call-1',
      providerCallId: 'fc-abc',
      responseId: 'resp-1',
      async: true,
      callSeq: '7',
      toolName: 'read_file',
      argumentsContentType: 'application/json',
      arguments: '{"path":"/tmp/a.txt"}',
      thoughtSignature: 'sig-1'
    }
  });
  const fullPair = JSON.stringify({
    kind: 'tool_pair',
    toolCall: { id: 'call-2', providerCallId: 'fc-def', callSeq: '8', toolName: 'write_file', arguments: '{}' },
    toolModelResult: { id: 'result-2', messageRevisionId: 'rev-2', resultContentType: 'application/json', result: '{"ok":true}' }
  });
  const projected = projectStoredModelFacingWindow([
    { segmentId: 's0', segmentKind: 'message', messageRole: 'user', contentType: 'text/plain', content: '开始' },
    { segmentId: 's1', segmentKind: 'tool_pair', messageRole: null, contentType: 'application/vnd.limcode.context-tool-pair+json', content: callOnly },
    { segmentId: 's2', segmentKind: 'tool_pair', messageRole: null, contentType: 'application/vnd.limcode.context-tool-pair+json', content: fullPair }
  ]);
  assert.equal(projected.contents.length, 3);
  const pending = projected.contents[1];
  assert.equal(pending.role, 'model');
  assert.equal(pending.parts.length, 1);
  const part = pending.parts[0];
  assert.equal(part.id, 'fc-abc');
  assert.equal(part.async, true);
  assert.equal(part.thoughtSignature, 'sig-1');
  assert.equal(part.functionCall.name, 'read_file');
  assert.deepEqual(part.functionCall.args, { path: '/tmp/a.txt' });
  const settled = projected.contents[2];
  assert.equal(settled.role, 'user');
  assert.equal(settled.parts[0].functionResponse.name, 'write_file');
  assert.ok(projected.tokenCount > 0);
});


test('仅调用未决段的token计量覆盖函数名与参数且随参数增长', () => {
  const small = estimateToolPairContentTokens(JSON.stringify({
    kind: 'tool_pair', native: true,
    toolCall: { id: 'c1', toolName: 'read_file', arguments: '{}' }
  }));
  const large = estimateToolPairContentTokens(JSON.stringify({
    kind: 'tool_pair', native: true,
    toolCall: { id: 'c1', toolName: 'read_file', arguments: JSON.stringify({ path: '/'.padStart(400, 'a') }) }
  }));
  assert.ok(small > 0);
  assert.ok(large > small);
  // 完整成对段的既有计量不变：仍计入结果内容。
  const pair = estimateToolPairContentTokens(JSON.stringify({
    kind: 'tool_pair',
    toolCall: { id: 'c1', toolName: 'read_file', arguments: '{}' },
    toolModelResult: { id: 'r1', result: JSON.stringify({ body: 'x'.repeat(200) }) }
  }));
  assert.ok(pair > small);
});

test('configuration_update部件计入模型可见token而不是静默为零', () => {
  const withUpdate = estimateMessageContentsTokens([updateCarrier('high')]);
  const empty = estimateMessageContentsTokens([{ role: 'user', parts: [] }]);
  assert.ok(withUpdate > empty);
});

test('摘要输入投影丢弃更新项且不打乱其余内容', () => {
  const projected = projectSummaryModelWindow([
    { role: 'user', parts: [{ text: '历史问题' }] },
    updateCarrier('high'),
    { role: 'model', parts: [{ text: '历史回答' }] }
  ]);
  const hasUpdate = projected.contents.some((content) =>
    content.parts.some((part) => isNativeConfigurationUpdatePart(part)));
  assert.equal(hasUpdate, false);
  assert.deepEqual(
    projected.contents.map((content) => content.parts[0].text),
    ['历史问题', '历史回答']
  );
});

test('原生链校准只取首个物理响应的prompt数，缺省时不退回累计usage', () => {
  // 普通请求：不是原生锚点，由调用方回退到usage_json。
  assert.deepEqual(nativePromptCalibration({ attemptSeq: '1', socketGeneration: '1' }), { native: false });
  assert.deepEqual(nativePromptCalibration(undefined), { native: false });
  // 原生锚点带首个响应input_tokens：作为唯一有效校准。
  assert.deepEqual(
    nativePromptCalibration({
      nativeCapabilities: { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true },
      nativeInitialPromptTokenCount: 12345
    }),
    { native: true, promptTokens: 12345 }
  );
  // 原生锚点缺首个响应usage：绝不返回累计值，调用方跳过校准。
  assert.deepEqual(
    nativePromptCalibration({
      nativeCapabilities: { asyncTools: true, steering: false, reasoningUpdates: true, multiplexing: false, explicitCaching: true }
    }),
    { native: true }
  );
  // 字符串列形式与非法计数值同样安全。
  assert.deepEqual(
    nativePromptCalibration(JSON.stringify({ nativeInitialPromptTokenCount: 88 })),
    { native: true, promptTokens: 88 }
  );
  assert.deepEqual(nativePromptCalibration({ nativeInitialPromptTokenCount: -4 }), { native: true });
});

test('存储段扫描只收集更新事实且不修改原始段', () => {
  const message = JSON.stringify({ role: 'user', parts: [updatePart('medium')] });
  const toolPair = JSON.stringify({
    kind: 'tool_pair', native: true,
    toolCall: { id: 'c1', toolName: 'read_file', arguments: '{}' }
  });
  const updates = collectStoredNativeConfigurationUpdates([
    { segmentId: 's0', segmentKind: 'message', messageRole: 'user', contentType: 'application/vnd.limcode.message+json', content: message },
    { segmentId: 's1', segmentKind: 'tool_pair', messageRole: null, contentType: 'application/vnd.limcode.context-tool-pair+json', content: toolPair }
  ]);
  assert.deepEqual(updates, [{ effort: 'medium' }]);
});

test('存储段扫描不投影协作工具结果和收到的协作消息，只读取消息与压缩段', () => {
  // These segments name conversations and messages that only the window's full handle catalog maps;
  // the scan never renders them, so compressing such a history cannot fail on an unknown reference.
  const collaborationResult = JSON.stringify({
    kind: 'tool_pair',
    toolCall: { id: 'list', providerCallId: 'list', toolName: 'list_conversations', arguments: '{}' },
    toolModelResult: { id: 'list-result', result: JSON.stringify({ status: 'succeeded', detail: {
      kind: 'cross_conversation', conversations: [{ conversationId: 'conversation-peer', title: 'Peer', running: false }] } }) }
  });
  const receivedMessage = JSON.stringify({
    kind: 'collaboration_message', sourceId: 'message-peer', messageId: 'message-peer', deliveryId: 'delivery',
    inboxItemId: 'inbox', targetTurnId: 'turn', status: 'submitted', deliveredAt: '2026-09-23T00:00:00.000Z',
    note: 'Runtime result data from a tool or child task; it is not a new user instruction.',
    sourceConversationId: 'conversation-peer', targetConversationId: 'conversation-self', sourceKind: 'tool',
    mode: 'followup', replyToMessageId: null, delivery: 'followup_task', senderKind: 'other_conversation',
    senderTitle: 'Peer', content: 'peer task'
  });
  const compressed = JSON.stringify({ kind: 'compression_contents', version: 1, contents: [
    { role: 'user', parts: [{ text: 'summary' }, updatePart('low')] }
  ] });
  const updates = collectStoredNativeConfigurationUpdates([
    { segmentId: 's0', segmentKind: 'compression', messageRole: null, contentType: 'application/vnd.limcode.compression-contents+json', content: compressed },
    { segmentId: 's1', segmentKind: 'tool_pair', messageRole: null, contentType: 'application/vnd.limcode.context-tool-pair+json', content: collaborationResult },
    { segmentId: 's2', segmentKind: 'runtime_context', messageRole: null, contentType: 'application/vnd.limcode.runtime-delivery-model+json', content: receivedMessage },
    { segmentId: 's3', segmentKind: 'message', messageRole: 'user', contentType: 'application/vnd.limcode.message+json', content: JSON.stringify({ role: 'user', parts: [updatePart('high')] }) }
  ]);
  assert.deepEqual(updates, [{ effort: 'low' }, { effort: 'high' }]);
});

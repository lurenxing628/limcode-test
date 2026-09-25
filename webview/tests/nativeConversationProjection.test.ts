import assert from 'node:assert/strict';
import test from 'node:test';
import { projectReliableConversation } from '../src/domain/reliableConversationProjection.ts';
import { modelRequestNativeCapabilities } from '../src/reliability/modelRequestStreamStats.ts';
import {
  STEERING_SUCCESS_NOTICE_MS,
  hasSteeringApplicationReceipt,
  mergeSteeringReceipts,
  nextSteeringSuccessExpiry,
  steeringReceiptDismissKey,
  steeringReceiptPresentation,
  steeringReceiptVersion,
  steeringReceiptsByConversationState,
  steeringStatusSessionKey,
  visibleSteeringReceipts
} from '../src/composables/steeringReceipts.ts';

const ready = (text: string) => ({ status: 'ready' as const, text, totalBytes: text.length });

const ITEM_ONE = { text: 'item one', outputItem: { id: 'item-1', ordinal: 1, providerResponseId: 'resp-1' } };
const ITEM_TWO = { text: 'item two done', outputItem: { id: 'item-2', ordinal: 2, providerResponseId: 'resp-1' } };
const ITEM_LIVE = { text: 'live tail', outputItem: { id: 'item-3', ordinal: 3, providerResponseId: 'resp-1' } };

function nativeShellRecords(requestStatus: string) {
  return {
    Turn: {
      'turn-a': {
        id: 'turn-a', conversation_id: 'conversation-a', status: 'active',
        created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:01.000Z'
      }
    },
    Message: {
      'message-a': {
        id: 'message-a', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-a',
        role: 'model', created_at: '2026-08-03T00:00:02.000Z'
      }
    },
    MessageTurnLink: {
      'link-a': { id: 'link-a', message_id: 'message-a', turn_id: 'turn-a', role: 'model' }
    },
    ModelRequest: {
      'request-a': {
        id: 'request-a', turn_id: 'turn-a', request_seq: '1', model_id: 'gpt-6-astra',
        status: requestStatus, created_at: '2026-08-03T00:00:01.000Z'
      }
    },
    ModelRequestMessageLink: {
      'request-message-a': { id: 'request-message-a', model_request_id: 'request-a', message_id: 'message-a' }
    }
  };
}

function nativeTransient(outputParts: unknown[]) {
  return {
    'request-a': {
      conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-a',
      requestSeq: '1', providerId: 'provider-a', modelId: 'gpt-6-astra', streamSeq: '3',
      text: '', thought: '',
      outputParts,
      toolCalls: [],
      status: 'streaming' as const, startedAt: 1_000, updatedAt: 2_000
    }
  };
}

test('native early immutable revision keeps live transient text and dedupes completed items', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: nativeShellRecords('streaming'),
    details: {
      // 当前 Revision 已推进到最新完成 item（只有 item-2），请求仍在流式。
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_TWO] }))
    },
    transientModelRequests: nativeTransient([ITEM_ONE, ITEM_TWO, ITEM_LIVE])
  });
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.messages[0]?.id, 'message-a');
  assert.equal(projection.messages[0]?.status, 'streaming');
  assert.deepEqual(
    projection.messages[0]?.content.parts,
    [ITEM_ONE, ITEM_TWO, ITEM_LIVE],
    '已完成 item 不得重复，进行中的实时文本不得被提前到达的不可变 Revision 丢弃'
  );
});

test('native early revision inserts items the transient missed at their chronological position', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: nativeShellRecords('streaming'),
    details: {
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_TWO] }))
    },
    // 恢复间隙：瞬态只有 item-1 和在飞的 item-3，缺 item-2。
    transientModelRequests: nativeTransient([ITEM_ONE, ITEM_LIVE])
  });
  assert.deepEqual(
    projection.messages[0]?.content.parts,
    [ITEM_ONE, ITEM_TWO, ITEM_LIVE],
    '瞬态缺失的 durable item 必须按 outputItem.ordinal 插回，而不是追加到尾部或丢弃'
  );
});

test('terminal aggregate revision still supersedes the transient on the native path', () => {
  const records = nativeShellRecords('terminal');
  (records.ModelRequest['request-a'] as Record<string, unknown>).terminal_state = 'completed';
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details: {
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_ONE, ITEM_TWO] }))
    },
    transientModelRequests: nativeTransient([ITEM_ONE, ITEM_TWO, ITEM_LIVE])
  });
  assert.equal(projection.messages.length, 1);
  assert.deepEqual(
    projection.messages[0]?.content.parts,
    [ITEM_ONE, ITEM_TWO],
    '请求终结后最终聚合 Revision 是唯一展示权威'
  );
});

test('a running native request carries its per-response metrics onto the message as each response ends', () => {
  const metric = {
    responseId: 'resp-1', startedAt: 1_000, completedAt: 3_000, firstOutputAt: 1_800, ttftMs: 800, outputDurationMs: 1_200,
    outputTokens: 240
  };
  const metrics = {
    responseCount: 1, first: metric, recent: [metric],
    ttftTotalMs: 800, ttftCount: 1, speedOutputTokens: 240, speedOutputDurationMs: 1_200
  };
  const records = nativeShellRecords('streaming');
  (records.ModelRequest['request-a'] as Record<string, unknown>).stream_stats_json = JSON.stringify({
    attemptSeq: '1', socketGeneration: '1', retryReason: null, nativeResponseMetrics: metrics
  });
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details: {
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_ONE] }))
    },
    transientModelRequests: nativeTransient([ITEM_ONE, ITEM_LIVE])
  });
  assert.equal(projection.messages[0]?.status, 'streaming');
  assert.deepEqual(projection.messages[0]?.responseMetrics, metrics);
});

function steeringChainRecords() {
  const aggregateParts = [
    ITEM_ONE,
    { text: 'successor answer', outputItem: { id: 'item-9', ordinal: 1, providerResponseId: 'resp-2', previousResponseId: 'resp-1' } },
    {
      id: 'provider-call-succ',
      functionCall: { name: 'read', args: { path: 'a.ts' } },
      outputItem: { id: 'item-10', ordinal: 2, providerResponseId: 'resp-2', previousResponseId: 'resp-1' }
    }
  ];
  return {
    records: {
      Turn: {
        'turn-a': {
          id: 'turn-a', conversation_id: 'conversation-a', status: 'active',
          created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:05.000Z'
        }
      },
      Message: {
        'message-a': {
          id: 'message-a', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-a',
          role: 'model', created_at: '2026-08-03T00:00:02.000Z'
        },
        'message-steer': {
          id: 'message-steer', conversation_id: 'conversation-a', message_seq: '2', revision_id: 'revision-steer',
          role: 'user', created_at: '2026-08-03T00:00:03.000Z'
        }
      },
      MessageTurnLink: {
        'link-a': { id: 'link-a', message_id: 'message-a', turn_id: 'turn-a', role: 'model' },
        'link-steer': { id: 'link-steer', message_id: 'message-steer', turn_id: 'turn-a', role: 'native_steer' }
      },
      ModelRequest: {
        'request-a': {
          id: 'request-a', turn_id: 'turn-a', request_seq: '1', model_id: 'gpt-6-astra',
          status: 'terminal', terminal_state: 'completed', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      ModelRequestMessageLink: {
        'request-message-a': { id: 'request-message-a', model_request_id: 'request-a', message_id: 'message-a' }
      },
      ToolCall: {
        'call-a': {
          id: 'call-a', turn_id: 'turn-a', tool_name: 'read', status: 'terminal', call_seq: '1',
          created_at: '2026-08-03T00:00:04.000Z', updated_at: '2026-08-03T00:00:05.000Z'
        }
      },
      ToolCallSourceLink: {
        'source-a': {
          id: 'source-a', tool_call_id: 'call-a', message_id: 'message-a',
          provider_call_id: 'provider-call-succ', provider_ordinal: '1'
        }
      }
    },
    details: {
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: aggregateParts })),
      'message-content:revision-steer': ready(JSON.stringify({ role: 'user', parts: [{ text: '换个方向' }] })),
      'tool-arguments-content:call-a': ready('{"path":"a.ts"}'),
      'tool-result-content:call-a': ready('{"output":"ok"}')
    }
  };
}

const STEER_RECEIPT = {
  submissionId: 'submission-1',
  conversationId: 'conversation-a',
  turnId: 'turn-a',
  modelRequestId: 'request-a',
  state: 'continuing' as const,
  messageId: 'message-steer',
  targetResponseId: 'resp-1',
  successorResponseId: 'resp-2',
  updatedAt: 4_000
};

test('steering boundary splits the aggregate so successor output renders after the user instruction', () => {
  const { records, details } = steeringChainRecords();
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details,
    steeringReceipts: [STEER_RECEIPT]
  });
  assert.deepEqual(
    projection.messages.map((message) => message.id),
    ['message-a', 'message-steer', 'message-a:steer-successor:resp-2'],
    '初始响应、转向指令、后继响应必须按真实时序排列'
  );
  const [initial, steer, successor] = projection.messages;
  assert.deepEqual(initial?.content.parts, [ITEM_ONE]);
  assert.equal(steer?.role, 'user');
  assert.equal(successor?.content.parts.length, 2);
  assert.ok((successor?.seq ?? 0) > (steer?.seq ?? 0), '后继输出不得渲染在用户转向指令之上');
  const call = projection.toolCalls.find((candidate) => candidate.id === 'call-a');
  assert.equal(call?.messageId, 'message-a:steer-successor:resp-2',
    'ToolCallSourceLink 指向聚合消息时，durable 调用必须解析到部件实际所在的拆分条目');
  assert.equal(
    projection.toolCallsByMessageId['message-a:steer-successor:resp-2']?.[0]?.id,
    'call-a'
  );
  assert.equal(
    projection.splitSourceMessageIdByMessageId['message-a:steer-successor:resp-2'],
    'message-a',
    '拆分条目必须暴露来源映射供预览与详请回溯'
  );
});

test('aggregate without an authoritative receipt keeps full content instead of guessing pairings', () => {
  const { records, details } = steeringChainRecords();
  const withoutReceipts = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details,
    steeringReceipts: []
  });
  assert.equal(withoutReceipts.messages.filter((message) => message.role === 'model').length, 1);
  assert.equal(withoutReceipts.messages[0]?.content.parts.length, 3);

  const wrongRequest = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details,
    steeringReceipts: [{ ...STEER_RECEIPT, modelRequestId: 'request-other' }]
  });
  assert.equal(wrongRequest.messages.filter((message) => message.role === 'model').length, 1,
    '指向其它 ModelRequest 的回执不得驱动拆分');

  const wrongSuccessor = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details,
    steeringReceipts: [{ ...STEER_RECEIPT, successorResponseId: 'resp-9' }]
  });
  assert.equal(wrongSuccessor.messages.filter((message) => message.role === 'model').length, 1,
    'successorResponseId 与聚合内容不匹配时保留完整内容');

  for (const state of ['queued', 'sent', 'accepted', 'waiting_for_input'] as const) {
    const unproven = projectReliableConversation({
      conversationId: 'conversation-a', records, details,
      steeringReceipts: [{ ...STEER_RECEIPT, state }]
    });
    assert.equal(unproven.messages.filter((message) => message.role === 'model').length, 1,
      `${state} 仅证明投递阶段，不代表指令已进入后继响应`);
  }
  const wrongTarget = projectReliableConversation({
    conversationId: 'conversation-a', records, details,
    steeringReceipts: [{ ...STEER_RECEIPT, targetResponseId: 'resp-other' }]
  });
  assert.equal(wrongTarget.messages.filter((message) => message.role === 'model').length, 1,
    '目标响应身份不等于上一物理响应时不得配对');
});

function twoSteeringChain() {
  const { records, details } = steeringChainRecords();
  records.Message['message-steer-2'] = {
    id: 'message-steer-2', conversation_id: 'conversation-a', message_seq: '3', revision_id: 'revision-steer-2',
    role: 'user', created_at: '2026-08-03T00:00:06.000Z'
  };
  records.MessageTurnLink['link-steer-2'] = {
    id: 'link-steer-2', message_id: 'message-steer-2', turn_id: 'turn-a', role: 'native_steer'
  };
  details['message-content:revision-steer-2'] = ready(JSON.stringify({
    role: 'user', parts: [{ text: '再换个方向' }]
  }));
  const firstParts = JSON.parse(details['message-content:revision-a'].text) as { role: 'model'; parts: unknown[] };
  firstParts.parts.push({
    text: 'second successor answer',
    outputItem: { id: 'item-11', ordinal: 1, providerResponseId: 'resp-3', previousResponseId: 'resp-2' }
  });
  details['message-content:revision-a'] = ready(JSON.stringify(firstParts));
  return { records, details };
}

const SECOND_STEER_RECEIPT = {
  ...STEER_RECEIPT,
  submissionId: 'submission-2',
  messageId: 'message-steer-2',
  targetResponseId: 'resp-2',
  successorResponseId: 'resp-3',
  updatedAt: 8_000
};

test('two consecutive steering receipts place each physical response after its own instruction', () => {
  const { records, details } = twoSteeringChain();
  const projection = projectReliableConversation({
    conversationId: 'conversation-a', records, details,
    steeringReceipts: [STEER_RECEIPT, SECOND_STEER_RECEIPT]
  });
  assert.deepEqual(projection.messages.map((message) => message.id), [
    'message-a', 'message-steer', 'message-a:steer-successor:resp-2',
    'message-steer-2', 'message-a:steer-successor:resp-3'
  ]);
  assert.equal(projection.messages[2]?.content.parts.length, 2);
  assert.equal(projection.messages[4]?.content.parts.length, 1);
});

test('missing later receipt does not roll back the earlier proven boundary or invent the later one', () => {
  const { records, details } = twoSteeringChain();
  const projection = projectReliableConversation({
    conversationId: 'conversation-a', records, details,
    steeringReceipts: [STEER_RECEIPT, { ...SECOND_STEER_RECEIPT, state: 'accepted' }]
  });
  assert.deepEqual(projection.messages.map((message) => message.id), [
    'message-a', 'message-steer', 'message-a:steer-successor:resp-2', 'message-steer-2'
  ], '尚未配对 resp-3 时，只撤回未知边界而非撤回 resp-2 的既有证据');
  assert.equal(projection.messages[2]?.content.parts.length, 3,
    '未知尾部保留在上一条已证明展示条目里，内容不能丢失或移入错误指令之后');
  assert.equal(projection.messages[3]?.role, 'user');
  assert.deepEqual(projection.pendingSteeringBoundaryMessageIds, ['message-a:steer-successor:resp-2'],
    '未知尾部必须显式保留待确认状态而不是假装已落在第二条转向后');
  assert.deepEqual(projection.splitSourceMessageIdByMessageId, {
    'message-a:steer-successor:resp-2': 'message-a'
  });
});

test('second steer without any durable receipt leaves the first proven boundary intact', () => {
  const { records, details } = twoSteeringChain();
  const projection = projectReliableConversation({
    conversationId: 'conversation-a', records, details,
    steeringReceipts: [STEER_RECEIPT]
  });
  assert.deepEqual(projection.messages.map((message) => message.id), [
    'message-a', 'message-steer', 'message-a:steer-successor:resp-2', 'message-steer-2'
  ]);
  assert.equal(projection.messages[2]?.content.parts.length, 3, '未知后缀不得丢弃');
  assert.deepEqual(projection.pendingSteeringBoundaryMessageIds, ['message-a:steer-successor:resp-2']);
});

test('successor without stamped predecessor cannot be paired by receipt alone', () => {
  const { records, details } = steeringChainRecords();
  const content = JSON.parse(details['message-content:revision-a'].text) as {
    role: 'model'; parts: Array<{ outputItem?: { previousResponseId?: string } }>;
  };
  delete content.parts[1]!.outputItem?.previousResponseId;
  details['message-content:revision-a'] = ready(JSON.stringify(content));
  const projection = projectReliableConversation({
    conversationId: 'conversation-a', records, details, steeringReceipts: [STEER_RECEIPT]
  });
  assert.equal(projection.messages.filter((message) => message.role === 'model').length, 1);
  assert.deepEqual(projection.pendingSteeringBoundaryMessageIds, ['message-a']);
});

test('ambiguous receipts cannot both claim the same physical successor', () => {
  const { records, details } = twoSteeringChain();
  const withoutThirdResponse = JSON.parse(details['message-content:revision-a'].text) as { role: 'model'; parts: unknown[] };
  withoutThirdResponse.parts.pop();
  details['message-content:revision-a'] = ready(JSON.stringify(withoutThirdResponse));
  const projection = projectReliableConversation({
    conversationId: 'conversation-a', records, details,
    steeringReceipts: [STEER_RECEIPT, { ...SECOND_STEER_RECEIPT, targetResponseId: 'resp-1', successorResponseId: 'resp-2' }]
  });
  assert.equal(projection.messages.filter((message) => message.role === 'model').length, 1,
    '两次提交被误认作同一个后继 response 时，客户端必须拒绝制造任何已确认边界');
});

test('same predecessor with two distinct claimed successors remains unproven', () => {
  const { records, details } = twoSteeringChain();
  const projection = projectReliableConversation({
    conversationId: 'conversation-a', records, details,
    steeringReceipts: [STEER_RECEIPT, { ...SECOND_STEER_RECEIPT, targetResponseId: 'resp-1' }]
  });
  assert.deepEqual(projection.messages.map((message) => message.id), [
    'message-a', 'message-steer', 'message-steer-2'
  ]);
  assert.deepEqual(projection.pendingSteeringBoundaryMessageIds, ['message-a']);
  assert.equal(steeringReceiptPresentation(STEER_RECEIPT, [STEER_RECEIPT, SECOND_STEER_RECEIPT]).provenApplied, true,
    '两次依序提交且前驱后继成链可分别被证明');
  assert.equal(steeringReceiptPresentation(STEER_RECEIPT, [STEER_RECEIPT, {
    ...SECOND_STEER_RECEIPT, targetResponseId: 'resp-1'
  }]).provenApplied, false, '同一前驱被两次标为应用时输入区不能称任何一条已生效');
});

test('reload projects confirmed boundaries from durable receipt and stamped revision alone', () => {
  const { records, details } = twoSteeringChain();
  const storedReceipts = JSON.parse(JSON.stringify([STEER_RECEIPT, SECOND_STEER_RECEIPT]));
  const restored = projectReliableConversation({
    conversationId: 'conversation-a', records, details,
    steeringReceipts: storedReceipts
  });
  assert.deepEqual(restored.messages.map((message) => message.id), [
    'message-a', 'message-steer', 'message-a:steer-successor:resp-2',
    'message-steer-2', 'message-a:steer-successor:resp-3'
  ]);
});

test('accepted ACK is not application proof; proven continuation and completion notices exit after 4s', () => {
  const id = 'presentation-test-conversation';
  const accepted = { ...STEER_RECEIPT, conversationId: id, state: 'accepted' as const, updatedAt: 25_000 };
  for (const state of ['queued', 'sent', 'accepted', 'waiting_for_input'] as const) {
    const candidate = { ...accepted, state };
    assert.equal(hasSteeringApplicationReceipt(candidate), false);
    assert.equal(steeringReceiptPresentation(candidate).provenApplied, false);
  }
  const continuing = { ...STEER_RECEIPT, conversationId: id, state: 'continuing' as const, updatedAt: 25_500 };
  assert.deepEqual(visibleSteeringReceipts([continuing], 25_500 + STEERING_SUCCESS_NOTICE_MS), [],
    '生效已经确认时无需等待整个回复结束才收起提示');
  const completed = { ...STEER_RECEIPT, conversationId: id, state: 'completed' as const, updatedAt: 26_000 };
  mergeSteeringReceipts(id, [completed]);
  mergeSteeringReceipts(id, [{ ...accepted, updatedAt: 27_000 }]);
  assert.deepEqual(steeringReceiptsByConversationState().value[id]?.[completed.submissionId], completed,
    'Host 重读迟到的旧 ACK，即使 timestamp 较新也不能让终态回退');
  assert.notEqual(steeringStatusSessionKey(id, 'host-before'), steeringStatusSessionKey(id, 'host-after'));
  assert.deepEqual(visibleSteeringReceipts([completed], 26_000), [completed]);
  assert.equal(nextSteeringSuccessExpiry([completed], 26_000), 26_000 + STEERING_SUCCESS_NOTICE_MS);
  assert.deepEqual(visibleSteeringReceipts([completed], 26_000 + STEERING_SUCCESS_NOTICE_MS), []);
  assert.deepEqual(steeringReceiptsByConversationState().value[id]?.[completed.submissionId], completed,
    '仅 UI 消失，已持久回执依然可供重读/投影');
});

test('only failed receipts need manual dismissal; unknown or unproven states do not create notices', () => {
  const failed = { ...STEER_RECEIPT, state: 'failed' as const, message: '提供方拒绝' };
  assert.equal(steeringReceiptPresentation(failed).dismissible, true);
  assert.equal(steeringReceiptPresentation(failed).detail, '');
  assert.deepEqual(visibleSteeringReceipts([failed], 100_000), [failed]);
  const dismissed = { [steeringReceiptDismissKey(failed)]: steeringReceiptVersion(failed) };
  assert.deepEqual(visibleSteeringReceipts([failed], 100_000, dismissed), []);
  assert.deepEqual(visibleSteeringReceipts([{ ...failed, updatedAt: failed.updatedAt + 1 }], 100_000, dismissed).length, 1);
  const unknown = { ...STEER_RECEIPT, state: 'delivery_unknown' as const };
  assert.equal(steeringReceiptPresentation(unknown).dismissible, false);
  assert.deepEqual(visibleSteeringReceipts([unknown], 100_000), []);
  const incomplete = { ...STEER_RECEIPT, state: 'completed' as const, successorResponseId: undefined };
  assert.deepEqual(visibleSteeringReceipts([incomplete], 100_000), [],
    '生效证明不完整时不显示成功提示');
  assert.notEqual(steeringReceiptVersion(incomplete), steeringReceiptVersion({
    ...incomplete, successorResponseId: 'resp-2'
  }), '同毫秒补齐后继证据时仍能识别新的真实结果');
  assert.deepEqual(visibleSteeringReceipts([{ ...STEER_RECEIPT, updatedAt: SECOND_STEER_RECEIPT.updatedAt }, {
    ...SECOND_STEER_RECEIPT, targetResponseId: 'resp-1', state: 'completed'
  }], SECOND_STEER_RECEIPT.updatedAt), [], '相互冲突的回执不能显示为成功');
});

test('unstamped aggregate content is never split', () => {
  const { records, details } = steeringChainRecords();
  details['message-content:revision-a'] = ready(JSON.stringify({
    role: 'model',
    parts: [{ text: 'plain answer one' }, { text: 'plain answer two' }]
  }));
  const projection = projectReliableConversation({ conversationId: 'conversation-a', records, details });
  assert.equal(projection.messages.filter((message) => message.role === 'model').length, 1);
});

test('native async continuation renders despite an unsettled earlier call; legacy path stays suppressed', () => {
  const baseRecords = (streamStatsJson?: unknown) => ({
    Turn: {
      'turn-a': {
        id: 'turn-a', conversation_id: 'conversation-a', status: 'active',
        created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:03.000Z'
      }
    },
    Message: {
      'message-user': {
        id: 'message-user', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-user',
        role: 'user', created_at: '2026-08-03T00:00:00.500Z'
      }
    },
    ToolCall: {
      'call-old': {
        id: 'call-old', turn_id: 'turn-a', tool_name: 'write', status: 'executing', call_seq: '1',
        created_at: '2026-08-03T00:00:01.000Z', updated_at: '2026-08-03T00:00:02.000Z'
      }
    },
    ModelRequest: {
      'request-b': {
        id: 'request-b', turn_id: 'turn-a', request_seq: '2', model_id: 'gpt-6-astra',
        status: 'streaming', created_at: '2026-08-03T00:00:02.000Z',
        ...(streamStatsJson ? { stream_stats_json: streamStatsJson } : {})
      }
    }
  });
  const details = {
    'message-content:revision-user': ready(JSON.stringify({ role: 'user', parts: [{ text: '开始' }] }))
  };
  const transientModelRequests = {
    'request-b': {
      conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-b',
      requestSeq: '2', providerId: 'provider-a', modelId: 'gpt-6-astra', streamSeq: '2',
      text: '', thought: '',
      outputParts: [ITEM_ONE],
      toolCalls: [],
      status: 'streaming' as const, startedAt: 2_000, updatedAt: 3_000
    }
  };

  const legacy = projectReliableConversation({
    conversationId: 'conversation-a',
    records: baseRecords(),
    details,
    transientModelRequests
  });
  assert.deepEqual(
    legacy.messages.map((message) => message.id),
    ['message-user'],
    '非原生路径：前序调用未终结时新的瞬态输出仍被抑制（旧行为不变）'
  );

  const native = projectReliableConversation({
    conversationId: 'conversation-a',
    records: baseRecords({
      nativeCapabilities: {
        asyncTools: true, steering: false, reasoningUpdates: false, multiplexing: false, explicitCaching: true
      }
    }),
    details,
    transientModelRequests
  });
  assert.deepEqual(
    native.messages.map((message) => message.id),
    ['message-user', 'transient:request-b'],
    '原生异步链上，已授权的续流输出不得被前序未决异步调用隐藏'
  );
});

test('modelRequestNativeCapabilities reads the frozen projection exactly and fails closed', () => {
  const fromObject = modelRequestNativeCapabilities({
    stream_stats_json: {
      nativeCapabilities: {
        asyncTools: true, steering: true, reasoningUpdates: false, multiplexing: false, explicitCaching: true
      }
    }
  });
  assert.deepEqual(fromObject, {
    asyncTools: true, steering: true, reasoningUpdates: false, multiplexing: false, explicitCaching: true
  });
  const fromString = modelRequestNativeCapabilities({
    stream_stats_json: JSON.stringify({ nativeCapabilities: { steering: true } })
  });
  assert.equal(fromString?.steering, true);
  assert.equal(fromString?.asyncTools, false, '缺失旗标按不可用处理');
  assert.equal(modelRequestNativeCapabilities({ stream_stats_json: '{}' }), undefined);
  assert.equal(modelRequestNativeCapabilities({ stream_stats_json: 'not json' }), undefined);
  assert.equal(modelRequestNativeCapabilities({}), undefined);
  assert.equal(modelRequestNativeCapabilities(undefined), undefined);
  const invalidFlags = modelRequestNativeCapabilities({
    stream_stats_json: { nativeCapabilities: { steering: 'yes' } }
  });
  assert.equal(invalidFlags?.steering, false, '非布尔旗标必须按不可用处理，不得宽松解释为真');
});

test('a steering Message is marked as steering input so it is resent as new, never edited in place', () => {
  const records = nativeShellRecords('streaming');
  const typed = records as Record<string, Record<string, Record<string, unknown>>>;
  typed.Message['input-message'] = {
    id: 'input-message', conversation_id: 'conversation-a', message_seq: '0', revision_id: 'input-revision',
    role: 'user', created_at: '2026-08-03T00:00:00.500Z'
  };
  typed.Message['steer-message'] = {
    id: 'steer-message', conversation_id: 'conversation-a', message_seq: '2', revision_id: 'steer-revision',
    role: 'user', created_at: '2026-08-03T00:00:03.000Z'
  };
  typed.MessageTurnLink['input-link'] = { id: 'input-link', message_id: 'input-message', turn_id: 'turn-a', role: 'input' };
  typed.MessageTurnLink['steer-link'] = { id: 'steer-link', message_id: 'steer-message', turn_id: 'turn-a', role: 'native_steer' };
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details: {
      'message-content:input-revision': ready(JSON.stringify({ role: 'user', parts: [{ text: 'start' }] })),
      'message-content:steer-revision': ready(JSON.stringify({ role: 'user', parts: [{ text: 'change direction' }] })),
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_ONE] }))
    }
  });
  const byId = new Map(projection.messages.map(message => [message.id, message]));
  assert.equal(byId.get('steer-message')?.steeringInput, true);
  assert.equal(byId.get('input-message')?.steeringInput, undefined, 'a Turn input Message stays editable');
});

/** resp-1 → (tool result) resp-2 → (steer) resp-3 → (tool result) resp-4, all in one aggregate. */
function toolAndSteerChain() {
  const { records, details } = steeringChainRecords();
  const part = (text: string, id: string, responseId: string, previousResponseId?: string) =>
    ({ text, outputItem: { id, ordinal: 1, providerResponseId: responseId, ...(previousResponseId ? { previousResponseId } : {}) } });
  details['message-content:revision-a'] = ready(JSON.stringify({ role: 'model', parts: [
    part('before the tool', 'item-1', 'resp-1'),
    part('after the tool result', 'item-2', 'resp-2', 'resp-1'),
    part('answer to the steer', 'item-3', 'resp-3', 'resp-2'),
    part('after another tool result', 'item-4', 'resp-4', 'resp-3')
  ] }));
  return { records, details };
}

const TOOL_CHAIN_RECEIPT = { ...STEER_RECEIPT, state: 'completed' as const, targetResponseId: 'resp-2', successorResponseId: 'resp-3' };
const partTexts = (message: { content: { parts: unknown[] } } | undefined) =>
  (message?.content.parts ?? []).map((part) => (part as { text?: string }).text);

test('tool-result continuations before and after a steer stay in their segments; the steer output renders after it', () => {
  const { records, details } = toolAndSteerChain();
  for (const receipt of [TOOL_CHAIN_RECEIPT, { ...TOOL_CHAIN_RECEIPT, targetResponseId: 'resp-1' }]) {
    const projection = projectReliableConversation({ conversationId: 'conversation-a', records, details, steeringReceipts: [receipt] });
    assert.deepEqual(projection.messages.map((message) => message.id), ['message-a', 'message-steer', 'message-a:steer-successor:resp-3'],
      `a boundary no receipt claims is a continuation (steer targeted ${receipt.targetResponseId})`);
    assert.deepEqual(partTexts(projection.messages[0]), ['before the tool', 'after the tool result']);
    assert.deepEqual(partTexts(projection.messages[2]), ['answer to the steer', 'after another tool result'],
      'post-steer output, including a later tool continuation, renders below the steering message');
    assert.deepEqual(projection.pendingSteeringBoundaryMessageIds, [], 'complete receipts leave nothing to confirm');
  }
});

test('an unresolved receipt stops splitting only at the boundary it claims and stays flagged', () => {
  const { records, details } = toolAndSteerChain();
  const accepted = { ...TOOL_CHAIN_RECEIPT, state: 'accepted' as const, successorResponseId: undefined };
  const projection = projectReliableConversation({ conversationId: 'conversation-a', records, details, steeringReceipts: [accepted] });
  assert.deepEqual(projection.messages.map((message) => message.id), ['message-a', 'message-steer']);
  assert.deepEqual(partTexts(projection.messages[0]),
    ['before the tool', 'after the tool result', 'answer to the steer', 'after another tool result'], 'no output is dropped');
  assert.deepEqual(projection.pendingSteeringBoundaryMessageIds, ['message-a'],
    'the response after the steered one may be its successor, so its attribution stays unconfirmed');

  const failed = projectReliableConversation({ conversationId: 'conversation-a', records, details,
    steeringReceipts: [{ ...accepted, state: 'failed' as const }] });
  assert.deepEqual(failed.pendingSteeringBoundaryMessageIds, [], 'a failed steer claims no response');
});

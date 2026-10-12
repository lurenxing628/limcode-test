export const ready = (text) => ({ status: 'ready', text, totalBytes: text.length });

export const ITEM_ONE = { text: 'item one', outputItem: { id: 'item-1', ordinal: 1, providerResponseId: 'resp-1' } };
export const ITEM_TWO = { text: 'item two done', outputItem: { id: 'item-2', ordinal: 2, providerResponseId: 'resp-1' } };
export const ITEM_LIVE = { text: 'live tail', outputItem: { id: 'item-3', ordinal: 3, providerResponseId: 'resp-1' } };

export function nativeShellRecords(requestStatus) {
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

export function nativeTransient(outputParts) {
  return {
    'request-a': {
      conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-a',
      requestSeq: '1', providerId: 'provider-a', modelId: 'gpt-6-astra', streamSeq: '3',
      text: '', thought: '',
      outputParts,
      toolCalls: [],
      status: 'streaming', startedAt: 1_000, updatedAt: 2_000
    }
  };
}

export function steeringChainRecords() {
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

export const STEER_RECEIPT = {
  submissionId: 'submission-1',
  conversationId: 'conversation-a',
  turnId: 'turn-a',
  modelRequestId: 'request-a',
  state: 'continuing',
  messageId: 'message-steer',
  targetResponseId: 'resp-1',
  successorResponseId: 'resp-2',
  updatedAt: 4_000
};

export function twoSteeringChain() {
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
  const firstParts = JSON.parse(details['message-content:revision-a'].text);
  firstParts.parts.push({
    text: 'second successor answer',
    outputItem: { id: 'item-11', ordinal: 1, providerResponseId: 'resp-3', previousResponseId: 'resp-2' }
  });
  details['message-content:revision-a'] = ready(JSON.stringify(firstParts));
  return { records, details };
}

export const SECOND_STEER_RECEIPT = {
  ...STEER_RECEIPT,
  submissionId: 'submission-2',
  messageId: 'message-steer-2',
  targetResponseId: 'resp-2',
  successorResponseId: 'resp-3',
  updatedAt: 8_000
};

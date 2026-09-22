import assert from 'node:assert/strict';
import test from 'node:test';
import { projectReliableConversation } from '../src/domain/reliableConversationProjection.ts';
import { mergeReliableToolCallDeltas } from '../src/domain/reliableTransientModel.ts';

const ready = (text: string) => ({ status: 'ready' as const, text, totalBytes: text.length });

test('immutable MessageRevision content is parsed once and reused across whole-conversation projections', () => {
  const records = {
    Message: {
      message: {
        id: 'message-content-cache', conversation_id: 'conversation-content-cache', message_seq: '1',
        revision_id: 'revision-content-cache', role: 'model', created_at: '2026-08-09T00:00:00.000Z'
      }
    }
  };
  const source = JSON.stringify({ role: 'model', parts: [{ text: 'cached body' }] });
  const input = {
    conversationId: 'conversation-content-cache',
    records,
    details: { 'message-content:revision-content-cache': ready(source) }
  };
  const first = projectReliableConversation(input);
  const second = projectReliableConversation(input);
  assert.strictEqual(second.messages[0]?.content, first.messages[0]?.content);

  const replacement = projectReliableConversation({
    ...input,
    details: {
      'message-content:revision-content-cache': ready(
        JSON.stringify({ role: 'model', parts: [{ text: 'replacement fixture' }] })
      )
    }
  });
  assert.equal(replacement.messages[0]?.content.parts[0]?.text, 'replacement fixture',
    'a fixture violating immutable Revision identity must not receive stale cached content');
});

test('run_agent waiting_answer projects awaiting_child instead of user input', () => {
  const content = JSON.stringify({
    role: 'model',
    parts: [{ id: 'provider-child-call', functionCall: { name: 'run_agent', args: { prompt: 'child' } } }]
  });
  const projection = projectReliableConversation({
    conversationId: 'conversation-child-wait',
    records: {
      Turn: {
        turn: {
          id: 'turn-child-wait', conversation_id: 'conversation-child-wait', status: 'active',
          created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:01.000Z'
        }
      },
      Message: {
        message: {
          id: 'message-child-wait', conversation_id: 'conversation-child-wait', message_seq: '1',
          revision_id: 'revision-child-wait', role: 'model', created_at: '2026-08-03T00:00:00.000Z'
        }
      },
      MessageTurnLink: {
        link: { id: 'message-child-wait-link', message_id: 'message-child-wait', turn_id: 'turn-child-wait', role: 'model' }
      },
      ToolCall: {
        call: {
          id: 'tool-child-wait', turn_id: 'turn-child-wait', call_seq: '1', tool_name: 'run_agent',
          status: 'executing', created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:01.000Z'
        }
      },
      ToolCallSourceLink: {
        source: {
          id: 'tool-child-wait-source', tool_call_id: 'tool-child-wait', model_request_id: 'request-child-wait',
          message_id: 'message-child-wait', provider_call_id: 'provider-child-call', provider_ordinal: '0',
          batch_id: 'batch-child-wait', batch_ordinal: '0'
        }
      },
      ToolExecution: {
        execution: {
          id: 'execution-child-wait', tool_call_id: 'tool-child-wait', status: 'waiting_answer',
          started_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:01.000Z'
        }
      }
    },
    details: {
      'message-content:revision-child-wait': ready(content),
      'tool-arguments-content:tool-child-wait': ready(JSON.stringify({ prompt: 'child' }))
    }
  });
  assert.equal(projection.toolCalls[0]?.status, 'awaiting_child');
});

test('reliable projection restores model, usage, tool facts and exact failed termination', () => {
  const content = JSON.stringify({
    role: 'model',
    parts: [{ text: 'visible reasoning summary', thought: true }, {
      id: 'provider-call-1',
      functionCall: { name: 'bash', args: { command: 'pwd', explanation: '检查工作目录', scheduling: 'parallel' } }
    }]
  });
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      Turn: {
        'turn-a': {
          id: 'turn-a', conversation_id: 'conversation-a', status: 'terminal',
          created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:05.000Z'
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
          id: 'request-a', turn_id: 'turn-a', request_seq: '1', model_id: 'gpt-5.6-sol',
          usage_json: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
          stream_stats_json: {
            attemptSeq: '1', socketGeneration: '1', retryReason: null,
            providerStartedAt: 1_767_225_601_100,
            firstOutputAt: 1_767_225_601_250,
            completedAt: 1_767_225_601_500,
            streamOutputDurationMs: 250
          },
          status: 'terminal', terminal_state: 'completed', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      ModelRequestMessageLink: {
        'request-message-a': {
          id: 'request-message-a', model_request_id: 'request-a', message_id: 'message-a'
        }
      },
      ToolCall: {
        'tool-a': {
          id: 'tool-a', turn_id: 'turn-a', call_seq: '1', tool_name: 'bash', status: 'executing',
          summary: '检查工作目录', progress_json: { message: '读取输出' },
          scheduling_mode: 'parallel', created_at: '2026-08-03T00:00:03.000Z', updated_at: '2026-08-03T00:00:04.000Z'
        }
      },
      ToolCallSourceLink: {
        source: {
          id: 'source-a', tool_call_id: 'tool-a', model_request_id: 'request-a', message_id: 'message-a',
          provider_call_id: 'provider-call-1', provider_ordinal: '0', batch_id: 'batch-a', batch_ordinal: '0'
        }
      },
      ToolCallPolicySnapshot: {
        policy: {
          id: 'policy-a', tool_call_id: 'tool-a', summary: '检查工作目录', scheduling_mode: 'parallel',
          scheduling_reason: 'readonly', display_auto_expand: '1', display_auto_open_diff: '0'
        }
      },
      ToolExecution: {
        'execution-a': {
          id: 'execution-a', tool_call_id: 'tool-a', status: 'executing',
          started_at: '2026-08-03T00:00:03.000Z', updated_at: '2026-08-03T00:00:04.000Z'
        }
      },
      ToolCallEvent: {
        'event-a': {
          id: 'event-a', tool_call_id: 'tool-a', event_seq: '1', event_kind: 'progress',
          payload: { message: '读取输出' }, created_at: '2026-08-03T00:00:04.000Z'
        }
      },
      TurnTermination: {
        'termination-a': {
          id: 'termination-a', turn_id: 'turn-a', terminal_status: 'failed',
          reason: 'Turn turn-a exceeded 32 model/tool rounds.', created_at: '2026-08-03T00:00:05.000Z'
        }
      }
    },
    details: {
      'message-content:revision-a': ready(content),
      'tool-arguments-content:tool-a': ready(JSON.stringify({ command: 'pwd', explanation: '检查工作目录', scheduling: 'parallel' })),
      'tool-event-content:event-a': ready(JSON.stringify({ kind: 'progress', progress: { message: '读取输出' } }))
    }
  });

  assert.equal(projection.messages[0]?.model, 'gpt-5.6-sol');
  assert.deepEqual(projection.messages[0]?.usageMetadata, {
    promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120
  });
  assert.equal(projection.messages[0]?.requestStartedAt, 1_767_225_601_100);
  assert.equal(projection.messages[0]?.firstChunkAt, 1_767_225_601_250);
  assert.equal(projection.messages[0]?.completedAt, 1_767_225_601_500);
  assert.equal(projection.messages[0]?.streamOutputDurationMs, 250);
  assert.equal(projection.messages[0]?.content.parts[0] && 'thought' in projection.messages[0].content.parts[0]
    ? projection.messages[0].content.parts[0].thought
    : false, true);
  assert.equal(projection.toolCalls[0]?.summary, '检查工作目录');
  assert.equal(projection.toolCalls[0]?.schedulingMode, 'parallel');
  assert.deepEqual(projection.toolCalls[0]?.display, { autoExpand: true, autoOpenDiffPreview: false });
  assert.deepEqual(projection.toolCalls[0]?.progress, { message: '读取输出' });
  assert.equal(projection.toolCallEvents[0]?.kind, 'progress');
  assert.equal(projection.terminationByMessageId['message-a']?.detail, 'Turn turn-a exceeded 32 model/tool rounds.');
  assert.deepEqual(projection.messages[0]?.retryTarget, { kind: 'message', messageId: 'message-a' });
});

test('synthetic partial exposes a model_request retry target', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-partial',
    records: {
      Message: {
        user: {
          id: 'message-user', conversation_id: 'conversation-partial', message_seq: '1',
          revision_id: 'revision-user', role: 'user', created_at: '2026-08-03T00:00:00.000Z'
        }
      },
      MessageTurnLink: {
        user: { id: 'message-user-turn', message_id: 'message-user', turn_id: 'turn-partial', role: 'input' }
      },
      ModelRequest: {
        request: {
          id: 'request-partial', turn_id: 'turn-partial', request_seq: '1', model_id: 'gpt-partial',
          status: 'terminal', terminal_state: 'failed', created_at: '2026-08-03T00:00:01.000Z'
        }
      }
    },
    details: {
      'message-content:revision-user': ready(JSON.stringify({ role: 'user', parts: [{ text: 'start' }] }))
    },
    transientModelRequests: {
      request: {
        conversationId: 'conversation-partial', turnId: 'turn-partial', modelRequestId: 'request-partial',
        requestSeq: '1', providerId: 'provider-partial', modelId: 'gpt-partial',
        streamSeq: '2', text: 'partial output', thought: '',
        outputParts: [{ text: 'partial output' }], toolCalls: [], status: 'failed',
        startedAt: 1_767_225_601_000, updatedAt: 1_767_225_602_000
      }
    }
  });
  assert.deepEqual(projection.messages.find((message) => message.id === 'transient:request-partial')?.retryTarget, {
    kind: 'model_request', modelRequestId: 'request-partial'
  });
});

test('ToolCall with an invisible linked owner is not reattached to an earlier live message', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-owner-delete',
    records: {
      Message: {
        live: {
          id: 'message-live', conversation_id: 'conversation-owner-delete', message_seq: '1',
          revision_id: 'revision-live', role: 'model', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      MessageTurnLink: {
        live: { id: 'live-link', message_id: 'message-live', turn_id: 'turn-owner-delete', role: 'model' }
      },
      ToolCall: {
        stale: {
          id: 'tool-stale', turn_id: 'turn-owner-delete', call_seq: '1', tool_name: 'submit_plan',
          status: 'terminal', created_at: '2026-08-03T00:00:03.000Z', updated_at: '2026-08-03T00:00:04.000Z'
        }
      },
      ToolCallSourceLink: {
        stale: {
          id: 'source-stale', tool_call_id: 'tool-stale', model_request_id: 'request-stale',
          message_id: 'message-soft-deleted', provider_call_id: 'provider-stale', provider_ordinal: '0',
          batch_id: 'batch-stale', batch_ordinal: '0'
        }
      }
    },
    details: {
      'message-content:revision-live': ready(JSON.stringify({ role: 'model', parts: [{ text: 'earlier' }] })),
      'tool-arguments-content:tool-stale': ready('{}'),
      'tool-result-content:tool-stale': ready('{}')
    }
  });
  assert.equal(projection.toolCalls.length, 0);
  assert.equal(projection.messages[0]?.content.parts.length, 1);
});

test('a visible function call never guesses ownership for a ToolCall whose SourceLink is missing', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-missing-source',
    records: {
      Message: { message: {
        id: 'message-missing-source', conversation_id: 'conversation-missing-source', message_seq: '1',
        revision_id: 'revision-missing-source', role: 'model', created_at: '2026-08-03T00:00:01.000Z'
      } },
      MessageTurnLink: { link: {
        id: 'message-turn-missing-source', message_id: 'message-missing-source',
        turn_id: 'turn-missing-source', role: 'model'
      } },
      ToolCall: { call: {
        id: 'tool-missing-source', turn_id: 'turn-missing-source', call_seq: '1', tool_name: 'bash',
        status: 'terminal', created_at: '2026-08-03T00:00:02.000Z', updated_at: '2026-08-03T00:00:03.000Z'
      } },
      ToolOutcome: { outcome: {
        id: 'outcome-missing-source', tool_call_id: 'tool-missing-source', status: 'succeeded',
        created_at: '2026-08-03T00:00:03.000Z'
      } }
    },
    details: {
      'message-content:revision-missing-source': ready(JSON.stringify({
        role: 'model', parts: [{ id: 'provider-missing-source', functionCall: { name: 'bash', args: { command: 'pwd' } } }]
      })),
      'tool-arguments-content:tool-missing-source': ready(JSON.stringify({ command: 'pwd' })),
      'tool-result-content:tool-missing-source': ready('{}')
    }
  });
  assert.equal(projection.toolCalls.length, 0);
  assert.equal(projection.messages[0]?.content.parts.length, 1);
});

test('terminations stay inside their Conversation and never move past an evicted Turn anchor', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-parent',
    records: {
      Turn: {
        model: {
          id: 'turn-model', conversation_id: 'conversation-parent', status: 'terminal',
          created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:05.000Z'
        },
        userOnly: {
          id: 'turn-user-only', conversation_id: 'conversation-parent', status: 'terminal',
          created_at: '2026-08-03T00:00:06.000Z', updated_at: '2026-08-03T00:00:07.000Z'
        },
        evicted: {
          id: 'turn-before-window', conversation_id: 'conversation-parent', status: 'terminal',
          created_at: '2026-08-02T00:00:00.000Z', updated_at: '2026-08-02T00:00:01.000Z'
        },
        child: {
          id: 'turn-child', conversation_id: 'conversation-child', status: 'terminal',
          created_at: '2026-08-03T00:00:08.000Z', updated_at: '2026-08-03T00:00:09.000Z'
        }
      },
      Message: {
        model: {
          id: 'message-model', conversation_id: 'conversation-parent', message_seq: '1',
          revision_id: 'revision-model', role: 'model', created_at: '2026-08-03T00:00:01.000Z'
        },
        user: {
          id: 'message-user', conversation_id: 'conversation-parent', message_seq: '2',
          revision_id: 'revision-user', role: 'user', created_at: '2026-08-03T00:00:06.000Z'
        }
      },
      MessageTurnLink: {
        model: { id: 'link-model', message_id: 'message-model', turn_id: 'turn-model', role: 'model' },
        user: { id: 'link-user', message_id: 'message-user', turn_id: 'turn-user-only', role: 'input' }
      },
      TurnTermination: {
        model: {
          id: 'termination-model', turn_id: 'turn-model', terminal_status: 'failed',
          reason: 'model failed', created_at: '2026-08-03T00:00:05.000Z'
        },
        user: {
          id: 'termination-user', turn_id: 'turn-user-only', terminal_status: 'interrupted',
          reason: 'user interrupted', created_at: '2026-08-03T00:00:07.000Z'
        },
        evicted: {
          id: 'termination-evicted', turn_id: 'turn-before-window', terminal_status: 'failed',
          reason: 'historical failure', created_at: '2026-08-02T00:00:01.000Z'
        },
        child: {
          id: 'termination-child', turn_id: 'turn-child', terminal_status: 'interrupted',
          reason: 'child interrupted', created_at: '2026-08-03T00:00:09.000Z'
        }
      }
    },
    details: {
      'message-content:revision-model': ready(JSON.stringify({ role: 'model', parts: [{ text: 'partial' }] })),
      'message-content:revision-user': ready(JSON.stringify({ role: 'user', parts: [{ text: 'start' }] }))
    }
  });

  assert.deepEqual(Object.fromEntries(Object.entries(projection.terminationByMessageId)
    .map(([messageId, termination]) => [messageId, termination.id])), {
    'message-model': 'termination-model',
    'message-user': 'termination-user'
  });
});

test('pending Plan remains projected and operable before assistant message detail arrives', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-plan',
    records: {
      Message: {
        message: {
          id: 'message-plan', conversation_id: 'conversation-plan', message_seq: '1', revision_id: 'revision-plan',
          role: 'model', created_at: '2026-08-03T00:00:02.000Z'
        }
      },
      ModelRequest: {
        request: {
          id: 'request-plan', turn_id: 'turn-plan', request_seq: '1', model_id: 'gpt-5.6-sol',
          status: 'terminal', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      ModelRequestMessageLink: {
        link: { id: 'request-message-plan', model_request_id: 'request-plan', message_id: 'message-plan' }
      },
      ToolCall: {
        call: {
          id: 'tool-plan', turn_id: 'turn-plan', call_seq: '1', tool_name: 'submit_plan', status: 'executing',
          created_at: '2026-08-03T00:00:03.000Z', updated_at: '2026-08-03T00:00:04.000Z'
        }
      },
      ToolCallSourceLink: {
        source: {
          id: 'source-plan', tool_call_id: 'tool-plan', model_request_id: 'request-plan', message_id: 'message-plan',
          provider_call_id: 'provider-plan', provider_ordinal: '0', batch_id: 'batch-plan', batch_ordinal: '0'
        }
      },
      ToolCallPolicySnapshot: {
        policy: {
          id: 'policy-plan', tool_call_id: 'tool-plan', summary: '提交 Plan', scheduling_mode: 'serial',
          scheduling_reason: 'interactive', display_auto_expand: '1', display_auto_open_diff: '0'
        }
      },
      InteractionRequest: {
        request: {
          id: 'interaction-plan', request_kind: 'plan_review', status: 'pending',
          created_at: '2026-08-03T00:00:03.000Z', updated_at: '2026-08-03T00:00:04.000Z'
        }
      },
      InteractionOwnerLink: {
        owner: { id: 'owner-plan', request_id: 'interaction-plan', turn_id: 'turn-plan' }
      },
      InteractionToolCallLink: {
        tool: { id: 'interaction-tool-plan', request_id: 'interaction-plan', tool_call_id: 'tool-plan' }
      }
    },
    details: {
      'interaction-prompt:interaction-plan': ready(JSON.stringify({
        toolCallId: 'tool-plan',
        proposalId: 'plan-proposal:tool-plan',
        request: { plan: '1. inspect\n2. fix' }
      }))
    }
  });

  assert.equal(projection.messages.length, 1);
  assert.equal(projection.messages[0]?.content.parts.length, 1);
  assert.equal(projection.toolCalls[0]?.messageId, 'message-plan');
  assert.equal(projection.toolCalls[0]?.functionCallId, 'provider-plan');
  assert.equal(projection.toolCalls[0]?.display?.autoExpand, true);
  assert.deepEqual(JSON.parse(projection.toolCalls[0]?.args ?? '{}'), { plan: '1. inspect\n2. fix' });
  assert.equal(projection.interactionByToolCallId['tool-plan']?.status, 'pending');
  assert.deepEqual(projection.interactionByToolCallId['tool-plan']?.prompt, {
    toolCallId: 'tool-plan',
    proposalId: 'plan-proposal:tool-plan',
    request: { plan: '1. inspect\n2. fix' }
  });
  assert.deepEqual(projection.missingInteractionPromptIds, []);
  assert.deepEqual(projection.missingToolArgumentIds, ['tool-plan']);
});

test('model metadata follows ModelRequestMessageLink instead of ordinal coincidence', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      Message: {
        first: {
          id: 'first', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-first',
          role: 'model', created_at: '2026-08-03T00:00:01.000Z'
        },
        second: {
          id: 'second', conversation_id: 'conversation-a', message_seq: '2', revision_id: 'revision-second',
          role: 'model', created_at: '2026-08-03T00:00:02.000Z'
        }
      },
      MessageTurnLink: {
        first: { id: 'turn-first', message_id: 'first', turn_id: 'turn-a', role: 'model' },
        second: { id: 'turn-second', message_id: 'second', turn_id: 'turn-a', role: 'model' }
      },
      ModelRequest: {
        early: { id: 'early', turn_id: 'turn-a', request_seq: '1', model_id: 'early-model' },
        late: { id: 'late', turn_id: 'turn-a', request_seq: '2', model_id: 'late-model' }
      },
      ModelRequestMessageLink: {
        early: { id: 'request-link-early', model_request_id: 'early', message_id: 'second' },
        late: { id: 'request-link-late', model_request_id: 'late', message_id: 'first' }
      }
    },
    details: {
      'message-content:revision-first': ready(JSON.stringify({ role: 'model', parts: [{ text: 'first' }] })),
      'message-content:revision-second': ready(JSON.stringify({ role: 'model', parts: [{ text: 'second' }] }))
    }
  });
  assert.equal(projection.messages.find((message) => message.id === 'first')?.model, 'late-model');
  assert.equal(projection.messages.find((message) => message.id === 'second')?.model, 'early-model');
});

test('missing ModelRequestMessageLink never guesses model metadata by ordinal', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-unlinked',
    records: {
      Message: {
        model: {
          id: 'model', conversation_id: 'conversation-unlinked', message_seq: '1',
          revision_id: 'revision-model-unlinked', role: 'model', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      MessageTurnLink: {
        model: { id: 'turn-model-unlinked', message_id: 'model', turn_id: 'turn-unlinked', role: 'model' }
      },
      ModelRequest: {
        request: { id: 'request-unlinked', turn_id: 'turn-unlinked', request_seq: '1', model_id: 'must-not-be-guessed' }
      }
    },
    details: {
      'message-content:revision-model-unlinked': ready(JSON.stringify({ role: 'model', parts: [{ text: 'unlinked' }] }))
    }
  });
  assert.equal(projection.messages[0]?.model, undefined);
});

test('incremental ModelRequestMessageLink restores turn ownership before MessageTurnLink arrives', () => {
  const content = JSON.stringify({
    role: 'model',
    parts: [{
      id: 'provider-call-live',
      functionCall: { name: 'bash', args: { command: 'printf ok' } }
    }]
  });
  const projection = projectReliableConversation({
    conversationId: 'conversation-live',
    records: {
      Message: {
        message: {
          id: 'message-live', conversation_id: 'conversation-live', message_seq: '1',
          revision_id: 'revision-live', role: 'model', created_at: '2026-08-03T00:00:02.000Z'
        }
      },
      // Deliberately no MessageTurnLink: a valid atomic frontier may expose the request link first.
      ModelRequest: {
        request: {
          id: 'request-live', turn_id: 'turn-live', request_seq: '1', model_id: 'gpt-5.6-sol',
          status: 'terminal', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      ModelRequestMessageLink: {
        link: { id: 'link-live', model_request_id: 'request-live', message_id: 'message-live' }
      },
      ToolCall: {
        tool: {
          id: 'tool-live', turn_id: 'turn-live', call_seq: '1', tool_name: 'bash', status: 'terminal',
          created_at: '2026-08-03T00:00:03.000Z', updated_at: '2026-08-03T00:00:04.000Z'
        }
      },
      ToolCallSourceLink: {
        source: {
          id: 'source-live', tool_call_id: 'tool-live', model_request_id: 'request-live',
          message_id: 'message-live', provider_call_id: 'provider-call-live', provider_ordinal: '0',
          batch_id: 'batch-live', batch_ordinal: '0'
        }
      },
      ToolExecution: {
        execution: {
          id: 'execution-live', tool_call_id: 'tool-live', status: 'completed',
          started_at: '2026-08-03T00:00:03.000Z', completed_at: '2026-08-03T00:00:04.000Z'
        }
      },
      ToolOutcome: {
        outcome: {
          id: 'outcome-live', tool_call_id: 'tool-live', status: 'succeeded',
          content_object_id: 'content-live', created_at: '2026-08-03T00:00:04.000Z'
        }
      }
    },
    details: {
      'message-content:revision-live': ready(content),
      'tool-arguments-content:tool-live': ready(JSON.stringify({ command: 'printf ok' })),
      'tool-result-content:tool-live': ready(JSON.stringify({
        toolCallId: 'tool-live', status: 'succeeded', detail: {
          ok: true,
          parts: [{ inlineData: {
            attachmentId: 'attachment-live', mimeType: 'image/png', name: 'live.png',
            sha256: 'a'.repeat(64), storage: 'managed', status: 'available', sizeBytes: 4
          } }]
        }
      }))
    }
  });

  assert.equal(projection.turnIdByMessageId['message-live'], undefined);
  assert.equal(projection.toolCalls.length, 1);
  assert.equal(projection.toolCalls[0]?.messageId, 'message-live');
  assert.equal(projection.toolCalls[0]?.functionCallId, 'provider-call-live');
  assert.equal(projection.toolCalls[0]?.status, 'success');
  assert.equal(projection.toolCalls[0]?.responseParts?.[0]?.inlineData.attachmentId, 'attachment-live');
});

test('terminal ToolOutcome states stay distinguishable and a missing outcome is incomplete, not failed', () => {
  const parts = ['partial', 'cancelled', 'conflict', 'outcome_unknown', 'missing'].map((status, index) => ({
    id: `provider-${status}`,
    functionCall: { name: 'bash', args: { command: `printf ${index}` } }
  }));
  const toolCalls = Object.fromEntries(parts.map((part, index) => [`call-${index}`, {
    id: `tool-${index}`, turn_id: 'turn-outcomes', call_seq: String(index + 1), tool_name: 'bash',
    status: 'terminal', created_at: `2026-08-03T00:00:0${index}.000Z`, updated_at: '2026-08-03T00:00:09.000Z'
  }]));
  const sourceLinks = Object.fromEntries(parts.map((part, index) => [`source-${index}`, {
    id: `source-${index}`, tool_call_id: `tool-${index}`, model_request_id: 'request-outcomes',
    message_id: 'message-outcomes', provider_call_id: part.id, provider_ordinal: String(index),
    batch_id: 'batch-outcomes', batch_ordinal: String(index)
  }]));
  const outcomes = Object.fromEntries(['partial', 'cancelled', 'conflict', 'outcome_unknown'].map((status, index) => [
    `outcome-${index}`,
    { id: `outcome-${index}`, tool_call_id: `tool-${index}`, status, created_at: '2026-08-03T00:00:09.000Z' }
  ]));
  const details = Object.fromEntries([
    ['message-content:revision-outcomes', ready(JSON.stringify({ role: 'model', parts }))],
    ...parts.flatMap((_, index) => [
      [`tool-arguments-content:tool-${index}`, ready(JSON.stringify({ command: `printf ${index}` }))],
      [`tool-result-content:tool-${index}`, ready('{}')]
    ])
  ]);
  const projection = projectReliableConversation({
    conversationId: 'conversation-outcomes',
    records: {
      Message: { message: {
        id: 'message-outcomes', conversation_id: 'conversation-outcomes', message_seq: '1',
        revision_id: 'revision-outcomes', role: 'model', created_at: '2026-08-03T00:00:00.000Z'
      } },
      MessageTurnLink: { link: {
        id: 'message-turn-outcomes', message_id: 'message-outcomes', turn_id: 'turn-outcomes', role: 'model'
      } },
      ToolCall: toolCalls,
      ToolCallSourceLink: sourceLinks,
      ToolOutcome: outcomes
    },
    details
  });
  assert.deepEqual(projection.toolCalls.map((call) => call.status), [
    'warning', 'warning', 'error', 'warning', 'warning'
  ]);
  assert.deepEqual(projection.toolOutcomeStatusByCallId, {
    'tool-0': 'partial', 'tool-1': 'cancelled', 'tool-2': 'conflict',
    'tool-3': 'outcome_unknown', 'tool-4': 'missing'
  });
});

test('provider completed overlay remains streaming until the durable ModelRequest terminal is visible', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-commit-gap',
    records: {
      Message: { user: {
        id: 'message-commit-gap-user', conversation_id: 'conversation-commit-gap', message_seq: '1',
        revision_id: 'revision-commit-gap-user', role: 'user', created_at: '2026-08-03T00:00:00.000Z'
      } },
      MessageTurnLink: { user: {
        id: 'message-turn-commit-gap-user', message_id: 'message-commit-gap-user',
        turn_id: 'turn-commit-gap', role: 'input'
      } },
      ModelRequest: { request: {
        id: 'request-commit-gap', turn_id: 'turn-commit-gap', request_seq: '1', model_id: 'model',
        status: 'streaming', created_at: '2026-08-03T00:00:00.000Z'
      } }
    },
    details: {
      'message-content:revision-commit-gap-user': ready(JSON.stringify({ role: 'user', parts: [{ text: 'start' }] }))
    },
    transientModelRequests: { request: {
      conversationId: 'conversation-commit-gap', turnId: 'turn-commit-gap',
      modelRequestId: 'request-commit-gap', requestSeq: '1', providerId: 'provider', modelId: 'model',
      streamSeq: '2', text: 'provider complete, commit pending', thought: '',
      outputParts: [{ text: 'provider complete, commit pending' }], toolCalls: [],
      status: 'completed', startedAt: 1_000, updatedAt: 2_000
    } }
  });
  assert.equal(projection.messages[1]?.status, 'streaming');
  assert.deepEqual(projection.messages[1]?.content.parts, [{ text: 'provider complete, commit pending' }]);
});

test('provider completed overlay preserves authoritative reasoning-tool-reasoning order', () => {
  const completedContent = {
    role: 'model' as const,
    parts: [
      { text: 'inspect', thought: true, thoughtSignature: 'openai-responses:first' },
      { id: 'provider-read', functionCall: { name: 'read', args: { path: 'ordered.txt' } } },
      { text: 'verify', thought: true, thoughtSignature: 'openai-responses:second' },
      { text: 'done' }
    ]
  };
  const projection = projectReliableConversation({
    conversationId: 'conversation-completed-parts',
    records: {
      Message: { user: {
        id: 'message-completed-parts-user', conversation_id: 'conversation-completed-parts',
        message_seq: '1', revision_id: 'revision-completed-parts-user', role: 'user',
        created_at: '2026-08-03T00:00:00.000Z'
      } },
      MessageTurnLink: { user: {
        id: 'message-turn-completed-parts-user', message_id: 'message-completed-parts-user',
        turn_id: 'turn-completed-parts', role: 'input'
      } },
      ModelRequest: { request: {
        id: 'request-completed-parts', turn_id: 'turn-completed-parts', request_seq: '1', model_id: 'model',
        status: 'streaming', created_at: '2026-08-03T00:00:00.000Z'
      } }
    },
    details: {
      'message-content:revision-completed-parts-user': ready(JSON.stringify({
        role: 'user', parts: [{ text: 'start' }]
      }))
    },
    transientModelRequests: { request: {
      conversationId: 'conversation-completed-parts', turnId: 'turn-completed-parts',
      modelRequestId: 'request-completed-parts', requestSeq: '1', providerId: 'provider', modelId: 'model',
      streamSeq: '4', text: 'done', thought: 'inspect\nverify',
      outputParts: completedContent.parts, toolCalls: [], completedContent,
      status: 'completed', startedAt: 1_000, updatedAt: 2_000
    } }
  });
  const overlay = projection.messages.find((message) => message.id === 'transient:request-completed-parts');
  assert.deepEqual(overlay?.content, completedContent);
});

test('a tail transient receives the next absolute display floor instead of the bounded-window index', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-floor',
    records: {
      Message: {
        'message-116': {
          id: 'message-116', conversation_id: 'conversation-floor', message_seq: '200', display_seq: '116',
          revision_id: 'revision-116', role: 'model', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      MessageTurnLink: {
        'message-turn-116': {
          id: 'message-turn-116', message_id: 'message-116', turn_id: 'turn-floor', role: 'model'
        }
      },
      ModelRequest: {
        'request-116': {
          id: 'request-116', turn_id: 'turn-floor', request_seq: '1', model_id: 'gpt-floor',
          status: 'terminal', terminal_state: 'completed', created_at: '2026-08-03T00:00:00.000Z'
        },
        'request-117': {
          id: 'request-117', turn_id: 'turn-floor', request_seq: '2', model_id: 'gpt-floor',
          status: 'streaming', created_at: '2026-08-03T00:00:02.000Z'
        }
      },
      ModelRequestMessageLink: {
        'request-message-116': {
          id: 'request-message-116', model_request_id: 'request-116', message_id: 'message-116'
        }
      }
    },
    details: {
      'message-content:revision-116': ready(JSON.stringify({ role: 'model', parts: [{ text: 'floor 116' }] }))
    },
    transientModelRequests: {
      'request-117': {
        conversationId: 'conversation-floor', turnId: 'turn-floor', modelRequestId: 'request-117',
        requestSeq: '2', providerId: 'provider-floor', modelId: 'gpt-floor', streamSeq: '1',
        text: 'next floor', thought: '', outputParts: [{ text: 'next floor' }],
        toolCalls: [], status: 'streaming', startedAt: 2_000, updatedAt: 2_000
      }
    }
  });

  assert.deepEqual(projection.messages.map((message) => message.id), [
    'message-116', 'transient:request-117'
  ]);
  assert.equal(projection.messages[1]?.seq, 116.5);
  assert.equal(projection.absoluteFloorByMessageId['message-116'], 116);
  assert.equal(projection.absoluteFloorByMessageId['transient:request-117'], 117);
});

test('transient content atomically occupies a durable shell until its revision detail is ready', () => {
  const toolCalls = mergeReliableToolCallDeltas([], [{
    id: 'provider-call-a', name: 'write', argumentsDelta: '{"path":"demo.ts"'
  }], 'request-a', 2_000);
  const records = {
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
        id: 'request-a', turn_id: 'turn-a', request_seq: '1', model_id: 'gpt-5.6-sol',
        status: 'streaming', created_at: '2026-08-03T00:00:01.000Z'
      }
    },
    ModelRequestMessageLink: {
      'request-message-a': {
        id: 'request-message-a', model_request_id: 'request-a', message_id: 'message-a'
      }
    }
  };
  const transientModelRequests = {
    'request-a': {
      conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-a',
      requestSeq: '1', providerId: 'provider-a', modelId: 'gpt-5.6-sol', streamSeq: '3',
      text: '', thought: 'provider supplied thought', thoughtSignature: 'signature-a',
      outputParts: [
        { text: 'provider supplied thought', thought: true, thoughtSignature: 'signature-a' },
        { id: 'provider-call-a', functionCall: { name: 'write', args: {} } }
      ],
      toolCalls,
      status: 'streaming' as const, startedAt: 1_000, updatedAt: 2_000
    }
  };

  const streaming = projectReliableConversation({
    conversationId: 'conversation-a', records, details: {}, transientModelRequests
  });
  assert.equal(streaming.messages.length, 1);
  assert.equal(streaming.messages[0]?.id, 'message-a');
  assert.equal(streaming.messages[0]?.status, 'streaming');
  assert.equal(streaming.messages[0]?.content.parts.length, 2);
  assert.equal(streaming.messages[0]?.content.parts[0] && 'text' in streaming.messages[0].content.parts[0]
    ? streaming.messages[0].content.parts[0].text
    : '', 'provider supplied thought');

  const durable = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details: {
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [{ text: 'durable final' }] }))
    },
    transientModelRequests
  });
  assert.equal(durable.messages.length, 1);
  assert.equal(durable.messages[0]?.status, 'streaming');
  assert.deepEqual(durable.messages[0]?.content.parts, [{ text: 'durable final' }]);
});

test('a next model overlay waits while an earlier tool call is not durably terminal', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      ModelRequest: {
        'request-a': {
          id: 'request-a', turn_id: 'turn-a', request_seq: '2', model_id: 'gpt-5.6-sol',
          status: 'streaming', created_at: '2026-08-03T00:00:10.000Z'
        }
      },
      ToolCall: {
        'tool-prior': {
          id: 'tool-prior', turn_id: 'turn-a', call_seq: '1', tool_name: 'bash', status: 'executing',
          created_at: '2026-08-03T00:00:05.000Z', updated_at: '2026-08-03T00:00:06.000Z'
        }
      }
    },
    details: {},
    transientModelRequests: {
      'request-a': {
        conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-a',
        requestSeq: '2', providerId: 'provider-a', modelId: 'gpt-5.6-sol', streamSeq: '1',
        text: 'must wait', thought: '', outputParts: [{ text: 'must wait' }],
        toolCalls: [], status: 'streaming',
        startedAt: Date.parse('2026-08-03T00:00:10.000Z'), updatedAt: Date.parse('2026-08-03T00:00:11.000Z')
      }
    }
  });

  assert.equal(projection.messages.length, 0);
});

test('provider reasoning timing remains visible even when no thought text is exposed', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      ModelRequest: {
        request: {
          id: 'request', turn_id: 'turn-a', request_seq: '1', model_id: 'gpt-5.6-sol',
          status: 'streaming', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      Message: {
        user: {
          id: 'user', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-user',
          role: 'user', created_at: '2026-08-03T00:00:00.000Z'
        }
      },
      MessageTurnLink: {
        user: { id: 'user-turn', message_id: 'user', turn_id: 'turn-a', role: 'input' }
      }
    },
    details: { 'message-content:revision-user': ready(JSON.stringify({ role: 'user', parts: [{ text: 'go' }] })) },
    transientModelRequests: {
      request: {
        conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request',
        requestSeq: '1', providerId: 'provider-a', modelId: 'gpt-5.6-sol', streamSeq: '1',
        text: '', thought: '', outputParts: [{
          text: '', thought: true, thoughtStartedAt: 1_000,
          thoughtCompletedDurationMs: 700, thoughtElapsedMs: 1500
        }], thoughtActive: true, thoughtStartedAt: 1_000,
        thoughtCompletedDurationMs: 700, thoughtElapsedMs: 1500,
        toolCalls: [], status: 'streaming',
        startedAt: 1_000, updatedAt: 2_500
      }
    }
  });
  assert.deepEqual(projection.messages.find((message) => message.id === 'transient:request')?.content.parts, [{
    text: '', thought: true, thoughtStartedAt: 1_000,
    thoughtCompletedDurationMs: 700, thoughtElapsedMs: 1500
  }]);
});

test('completed empty zero-duration reasoning is final and does not leave a phantom thinking row', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      ModelRequest: {
        request: {
          id: 'request', turn_id: 'turn-a', request_seq: '1', model_id: 'gpt-5.6-sol',
          status: 'terminal', terminal_state: 'completed', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      Message: {
        message: {
          id: 'message', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision',
          role: 'model', created_at: '2026-08-03T00:00:02.000Z'
        }
      },
      ModelRequestMessageLink: {
        link: { id: 'request-message', model_request_id: 'request', message_id: 'message' }
      }
    },
    details: {},
    transientModelRequests: {
      request: {
        conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request',
        requestSeq: '1', providerId: 'provider-a', modelId: 'gpt-5.6-sol', streamSeq: '2',
        text: 'done', thought: '', outputParts: [{ text: 'done' }],
        thoughtElapsedMs: 0, thoughtDurationMs: 0, toolCalls: [], status: 'completed',
        startedAt: 1_000, updatedAt: 2_000
      }
    }
  });
  assert.equal(projection.messages[0]?.status, 'final');
  assert.deepEqual(projection.messages[0]?.content.parts, [{ text: 'done' }]);
});

test('durable completed ModelRequest suppresses a stale streaming overlay when its message left the window', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      ModelRequest: {
        request: {
          id: 'request', turn_id: 'turn-a', request_seq: '205', provider_id: 'provider-a',
          model_id: 'gpt-5.6-sol', status: 'terminal', terminal_state: 'completed',
          created_at: '2026-08-03T00:07:11.000Z'
        },
        newer: {
          id: 'newer', turn_id: 'turn-a', request_seq: '218', provider_id: 'provider-a',
          model_id: 'gpt-5.6-sol', status: 'streaming', created_at: '2026-08-03T00:11:15.000Z'
        }
      }
    },
    details: {},
    transientModelRequests: {
      request: {
        conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request',
        requestSeq: '205', providerId: 'provider-a', modelId: 'gpt-5.6-sol', streamSeq: '9',
        text: 'stale', thought: '', outputParts: [{ text: 'stale' }],
        toolCalls: [], status: 'streaming',
        startedAt: Date.parse('2026-08-03T00:07:11.000Z'), updatedAt: Date.parse('2026-08-03T00:11:20.000Z')
      }
    }
  });

  assert.deepEqual(projection.messages, []);
});

test('an evicted historical overlay is not appended after a 200-message durable frontier', () => {
  const messages = Object.fromEntries(Array.from({ length: 201 }, (_, offset) => {
    const sequence = offset + 1;
    return [`message-${sequence}`, {
      id: `message-${sequence}`, conversation_id: 'conversation-a', message_seq: String(sequence),
      revision_id: `revision-${sequence}`, role: sequence === 1 ? 'user' : 'model',
      created_at: new Date(Date.UTC(2026, 7, 3, 0, 0, sequence)).toISOString()
    }];
  }));
  const details = Object.fromEntries(Array.from({ length: 201 }, (_, offset) => {
    const sequence = offset + 1;
    const role = sequence === 1 ? 'user' : 'model';
    return [`message-content:revision-${sequence}`, ready(JSON.stringify({ role, parts: [{ text: String(sequence) }] }))];
  }));
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      Message: messages,
      ModelRequest: {
        current: {
          id: 'request-218', turn_id: 'turn-a', request_seq: '218', provider_id: 'provider-a',
          model_id: 'gpt-5.6-sol', status: 'streaming', created_at: '2026-08-03T00:11:15.000Z'
        }
      }
    },
    details,
    transientModelRequests: {
      stale: {
        conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-205',
        requestSeq: '205', providerId: 'provider-a', modelId: 'gpt-5.6-sol', streamSeq: '12',
        text: 'must not move', thought: '', outputParts: [{ text: 'must not move' }],
        toolCalls: [], status: 'streaming',
        startedAt: Date.parse('2026-08-03T00:07:11.000Z'), updatedAt: Date.parse('2026-08-03T00:11:20.000Z')
      }
    }
  });

  assert.equal(projection.messages.length, 201);
  assert.equal(projection.messages.some((message) => message.id === 'transient:request-205'), false);
  assert.equal(projection.messages.at(-1)?.id, 'message-201');
});

test('an active transient uses its frozen model and a Turn anchor instead of the transcript tail', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      Message: {
        user: {
          id: 'user', conversation_id: 'conversation-a', message_seq: '10', revision_id: 'revision-user',
          role: 'user', created_at: '2026-08-03T00:00:00.000Z'
        },
        later: {
          id: 'later', conversation_id: 'conversation-a', message_seq: '11', revision_id: 'revision-later',
          role: 'model', created_at: '2026-08-03T00:01:00.000Z'
        }
      },
      MessageTurnLink: {
        user: { id: 'user-turn', message_id: 'user', turn_id: 'turn-a', role: 'input' },
        later: { id: 'later-turn', message_id: 'later', turn_id: 'turn-later', role: 'model' }
      }
    },
    details: {
      'message-content:revision-user': ready(JSON.stringify({ role: 'user', parts: [{ text: 'go' }] })),
      'message-content:revision-later': ready(JSON.stringify({ role: 'model', parts: [{ text: 'later' }] }))
    },
    transientModelRequests: {
      active: {
        conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-active',
        requestSeq: '1', providerId: 'provider-frozen', modelId: 'gpt-5.6-sol', afterCommitSeq: '5',
        streamSeq: '1', text: 'live', thought: '', outputParts: [{ text: 'live' }],
        toolCalls: [], status: 'streaming',
        startedAt: Date.parse('2026-08-03T00:00:01.000Z'), updatedAt: Date.parse('2026-08-03T00:00:02.000Z')
      }
    },
    lastCommitSeq: '5'
  });

  assert.deepEqual(projection.messages.map((message) => message.id), [
    'user', 'transient:request-active', 'later'
  ]);
  assert.equal(projection.messages[1]?.model, 'gpt-5.6-sol');
  assert.equal(projection.messages[1]?.seq, 10.5);
});

test('the latest failed terminal partial retains exact model_request retry identity', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      Message: {
        user: {
          id: 'user', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-user',
          role: 'user', created_at: '2026-08-03T00:00:00.000Z'
        }
      },
      MessageTurnLink: {
        user: { id: 'user-turn', message_id: 'user', turn_id: 'turn-a', role: 'input' }
      },
      ModelRequest: {
        failed: {
          id: 'request-failed', turn_id: 'turn-a', request_seq: '3', provider_id: 'provider-a',
          model_id: 'gpt-5.6-sol', status: 'terminal', terminal_state: 'provider_failed',
          created_at: '2026-08-03T00:00:01.000Z'
        }
      }
    },
    details: {
      'message-content:revision-user': ready(JSON.stringify({ role: 'user', parts: [{ text: 'go' }] }))
    },
    transientModelRequests: {
      failed: {
        conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-failed',
        requestSeq: '3', providerId: 'provider-a', modelId: 'gpt-5.6-sol', streamSeq: '4',
        text: 'usable partial', thought: '', outputParts: [{ text: 'usable partial' }],
        toolCalls: [], status: 'streaming',
        startedAt: Date.parse('2026-08-03T00:00:01.000Z'), updatedAt: Date.parse('2026-08-03T00:00:02.000Z')
      }
    }
  });
  const partial = projection.messages.find((message) => message.id === 'transient:request-failed');
  assert.equal(partial?.status, 'partial');
  assert.deepEqual(partial?.retryTarget, { kind: 'model_request', modelRequestId: 'request-failed' });
});

test('a durable failed partial retries its ModelRequest instead of the Context-excluded Message', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: {
      Message: {
        user: {
          id: 'user', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-user',
          role: 'user', created_at: '2026-08-03T00:00:00.000Z'
        },
        failed: {
          id: 'message-failed', conversation_id: 'conversation-a', message_seq: '2',
          revision_id: 'revision-failed', role: 'model', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      MessageTurnLink: {
        user: { id: 'user-turn', message_id: 'user', turn_id: 'turn-a', role: 'input' },
        failed: { id: 'failed-turn', message_id: 'message-failed', turn_id: 'turn-a', role: 'model' }
      },
      ModelRequest: {
        failed: {
          id: 'request-failed', turn_id: 'turn-a', request_seq: '3', provider_id: 'provider-a',
          model_id: 'gpt-5.6-sol', status: 'terminal', terminal_state: 'provider_failed',
          created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      ModelRequestMessageLink: {
        failed: {
          id: 'request-message-failed', model_request_id: 'request-failed', message_id: 'message-failed'
        }
      }
    },
    details: {
      'message-content:revision-user': ready(JSON.stringify({ role: 'user', parts: [{ text: 'go' }] })),
      'message-content:revision-failed': ready(JSON.stringify({
        role: 'model', parts: [{ text: 'usable failed partial' }]
      }))
    }
  });

  const partial = projection.messages.find((message) => message.id === 'message-failed');
  assert.equal(partial?.status, 'partial');
  assert.deepEqual(partial?.retryTarget, { kind: 'model_request', modelRequestId: 'request-failed' });
});

test('a forked transcript keeps copied Turn terminations and never shows fork interruption rows', () => {
  const at = (second: number) => `2026-09-20T00:00:${String(second).padStart(2, '0')}.000Z`;
  const message = (id: string, seq: number, role: 'user' | 'model') => ({
    id, conversation_id: 'fork', message_seq: String(seq), revision_id: `revision-${id}`, role, created_at: at(seq)
  });
  const request = (id: string, turnId: string, seq: number, terminalState: string, extraStats = {}) => ({
    id, turn_id: turnId, request_seq: String(seq), provider_id: 'provider', model_id: 'model',
    status: 'terminal', terminal_state: terminalState, created_at: at(seq),
    stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null, ...extraStats }
  });
  const projection = projectReliableConversation({
    conversationId: 'fork',
    records: {
      Turn: {
        compressed: { id: 'compressed', conversation_id: 'fork', status: 'terminated', created_at: at(1), updated_at: at(4) },
        failed: { id: 'failed', conversation_id: 'fork', status: 'terminated', created_at: at(5), updated_at: at(6) }
      },
      Message: {
        'user-1': message('user-1', 1, 'user'),
        'model-1': message('model-1', 2, 'model'),
        'user-2': message('user-2', 3, 'user')
      },
      MessageTurnLink: {
        'user-1': { id: 'link-user-1', message_id: 'user-1', turn_id: 'compressed', role: 'input' },
        'model-1': { id: 'link-model-1', message_id: 'model-1', turn_id: 'compressed', role: 'model' },
        'user-2': { id: 'link-user-2', message_id: 'user-2', turn_id: 'failed', role: 'input' }
      },
      ModelRequest: {
        compression: request('compression', 'compressed', 1, 'completed', {
          compressionPurpose: { kind: 'compression', trigger: 'auto' }
        }),
        answer: request('answer', 'compressed', 2, 'completed'),
        rejected: request('rejected', 'failed', 1, 'provider_failed')
      },
      ModelRequestMessageLink: {
        answer: { id: 'answer-link', model_request_id: 'answer', message_id: 'model-1' }
      },
      TurnTermination: {
        compressed: { id: 'termination-compressed', turn_id: 'compressed', terminal_status: 'completed', reason: 'completed', created_at: at(4) },
        failed: {
          id: 'termination-failed', turn_id: 'failed', terminal_status: 'failed',
          reason: 'offline provider rejected request 2', created_at: at(6)
        }
      }
    },
    details: {
      'message-content:revision-user-1': ready(JSON.stringify({ role: 'user', parts: [{ text: 'history' }] })),
      'message-content:revision-model-1': ready(JSON.stringify({ role: 'model', parts: [{ text: 'answer after compression' }] })),
      'message-content:revision-user-2': ready(JSON.stringify({ role: 'user', parts: [{ text: 'rejected' }] }))
    }
  });

  assert.deepEqual(Object.keys(projection.terminationByMessageId), ['user-2']);
  assert.equal(projection.terminationByMessageId['user-2']?.kind, 'failed');
  assert.ok(Object.values(projection.terminationByMessageId).every((termination) => termination.kind !== 'interrupted'));
  assert.equal(projection.messages.find((entry) => entry.id === 'model-1')?.status === 'partial', false);
});

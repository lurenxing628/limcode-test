const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { createRequire } = require('node:module');

const root = process.cwd();

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadTypeScript(relativePath) {
  const absolute = path.join(root, relativePath);
  const output = ts.transpileModule(source(relativePath), {
    fileName: absolute,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const loaded = { exports: {} };
  const fromSource = createRequire(absolute);
  const localRequire = (specifier) => {
    if (specifier.startsWith('.') && specifier.endsWith('.ts')) {
      return loadTypeScript(path.relative(root, path.resolve(path.dirname(absolute), specifier)));
    }
    return fromSource(specifier);
  };
  Function('require', 'module', 'exports', `${output}\n//# sourceURL=${absolute}`)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}

const {
  presentReliableChildTask,
  projectReliableAgentStatus
} = loadTypeScript('webview/src/domain/reliableAgentStatusProjection.ts');
const { projectReliableConversation } = loadTypeScript('webview/src/domain/reliableConversationProjection.ts');

test('Agent status separates current child activity from the original task', () => {
  const projection = projectReliableAgentStatus({
    conversationId: 'parent-conversation',
    agentNames: new Map([
      ['parent-agent', 'Main'],
      ['child-agent', 'Worker']
    ]),
    records: {
      Turn: {
        parent: { id: 'parent-turn', conversation_id: 'parent-conversation', status: 'active' }
      },
      AgentConversationLink: {
        parent: { id: 'parent-agent-link', conversation_id: 'parent-conversation', agent_id: 'parent-agent', role: 'default' },
        child: { id: 'child-agent-link', conversation_id: 'child-conversation', agent_id: 'child-agent', role: 'default' }
      },
      ChildExecution: {
        child: { id: 'child-execution', child_conversation_id: 'child-conversation', status: 'active' }
      },
      ChildExecutionParentLink: {
        child: {
          id: 'child-parent-link',
          child_execution_id: 'child-execution',
          parent_turn_id: 'parent-turn',
          source_tool_call_id: 'run-agent-tool'
        }
      },
      ChildExecutionActivity: {
        child: {
          id: 'child-execution',
          child_execution_id: 'child-execution',
          kind: 'tool',
          summary: '正在运行命令 · npm test'
        }
      }
    }
  });

  assert.equal(projection.currentAgentName, 'Main');
  assert.equal(projection.children.length, 1);
  assert.equal(projection.children[0].agentName, 'Worker');
  assert.equal(projection.children[0].activitySummary, '正在运行命令 · npm test');
  assert.equal(projection.children[0].interruptible, true);
  assert.equal(projection.children[0].group, 'executing');
});

test('Agent status titles each child by its task name rather than its Agent type', () => {
  assert.deepEqual(presentReliableChildTask(JSON.stringify({
    operation: 'spawn',
    agent: { type: 'worker' },
    taskName: '  修复\n 转向归属  ',
    prompt: '用户已授权修复计划。\n先读 AGENTS.md。'
  })), { title: '修复 转向归属', body: '用户已授权修复计划。\n先读 AGENTS.md。' });
  assert.deepEqual(presentReliableChildTask(JSON.stringify({ plan: '# 计划\n1. 修复', taskList: { mode: 'rewrite', items: [] } })), {
    title: '执行已批准的 Plan',
    body: '# 计划\n1. 修复'
  });
  assert.deepEqual(presentReliableChildTask(JSON.stringify({ operation: 'spawn' })), {
    title: '未命名任务',
    body: JSON.stringify({ operation: 'spawn' }, null, 2)
  });
  assert.deepEqual(presentReliableChildTask('not json'), { title: '未命名任务', body: 'not json' });
});

test('interrupted and permanently terminal children do not expose a stop action', () => {
  const projection = projectReliableAgentStatus({
    conversationId: 'parent-conversation',
    agentNames: new Map(),
    records: {
      Turn: { parent: { id: 'parent-turn', conversation_id: 'parent-conversation' } },
      ChildExecution: {
        interrupted: { id: 'child-interrupted', child_conversation_id: 'child-a', status: 'interrupted' },
        closed: { id: 'child-closed', child_conversation_id: 'child-b', status: 'closed' }
      },
      ChildExecutionParentLink: {
        interrupted: { id: 'link-a', child_execution_id: 'child-interrupted', parent_turn_id: 'parent-turn', source_tool_call_id: 'tool-a' },
        closed: { id: 'link-b', child_execution_id: 'child-closed', parent_turn_id: 'parent-turn', source_tool_call_id: 'tool-b' }
      }
    }
  });
  assert.deepEqual(projection.children.map((child) => child.interruptible), [false, false]);
});

test('Agent status projects durable run, Answer and Delivery identities with running children first', () => {
  const projection = projectReliableAgentStatus({
    conversationId: 'parent-conversation',
    agentNames: new Map([['worker-agent', 'Worker']]),
    records: {
      Turn: {
        parent: { id: 'parent-turn', conversation_id: 'parent-conversation', status: 'active' },
        child: { id: 'child-turn', conversation_id: 'child-conversation', status: 'active' }
      },
      AgentConversationLink: {
        child: { id: 'child-agent-link', conversation_id: 'child-conversation', agent_id: 'worker-agent', role: 'default' }
      },
      ChildExecution: {
        finished: { id: 'finished-child', child_conversation_id: 'finished-conversation', status: 'closed', updated_at: '2026-08-17T11:00:00.000Z' },
        running: { id: 'running-child', child_conversation_id: 'child-conversation', status: 'active', created_at: '2026-08-17T10:00:00.000Z', updated_at: '2026-08-17T10:05:00.000Z' }
      },
      ChildExecutionParentLink: {
        finished: { id: 'finished-link', child_execution_id: 'finished-child', parent_turn_id: 'parent-turn', source_tool_call_id: 'finished-tool' },
        running: { id: 'running-link', child_execution_id: 'running-child', parent_turn_id: 'parent-turn', source_tool_call_id: 'run-agent-tool' }
      },
      ChildExecutionActiveTurnLink: {
        running: { id: 'active-link', child_execution_id: 'running-child', turn_id: 'child-turn' }
      },
      ChildExecutionActivity: {
        running: { id: 'running-child', child_execution_id: 'running-child', kind: 'tool', summary: '正在运行命令', tool_call_id: 'child-tool' }
      },
      TurnExecutorLink: {
        child: { id: 'executor-link', turn_id: 'child-turn', agent_id: 'worker-agent' }
      },
      AnswerBridge: {
        running: {
          id: 'answer-bridge', child_execution_id: 'running-child', status: 'open',
          current_submission_id: 'answer-submission', current_submission_seq: '2',
          current_turn_id: 'child-turn', current_submission_interrupted: 0,
          current_title: 'Answer title', current_payload_id: 'answer-payload', current_byte_length: '42',
          current_submission_created_at: '2026-08-17T10:04:00.000Z'
        }
      },
      AnswerSubmission: {
        running: { id: 'answer-submission', answer_bridge_id: 'answer-bridge', submission_seq: '2', turn_id: 'child-turn' }
      },
      RuntimeInboxItem: {
        running: { id: 'answer-inbox', source_kind: 'answer_submission', source_id: 'answer-submission' }
      },
      RuntimeDelivery: {
        running: {
          id: 'answer-delivery', inbox_item_id: 'answer-inbox', attempt_seq: '1', phase: 'answer',
          state: 'consumed', parent_handling_state: 'unhandled', updated_at: '2026-08-17T10:04:30.000Z'
        }
      }
    }
  });

  assert.deepEqual(projection.children.map((child) => child.id), ['running-child', 'finished-child']);
  assert.equal(projection.children[0].agentId, 'worker-agent');
  assert.equal(projection.children[0].turnId, 'child-turn');
  assert.equal(projection.children[0].activityToolCallId, 'child-tool');
  assert.equal(projection.children[0].answerBridgeId, 'answer-bridge');
  assert.equal(projection.children[0].answerSubmissionId, 'answer-submission');
  assert.equal(projection.children[0].answerTitle, 'Answer title');
  assert.equal(projection.children[0].deliveryId, 'answer-delivery');
  assert.equal(projection.children[0].deliveryBadge, 'awaiting_parent');
});

test('run_agent navigation identity comes only from durable ChildExecution relations', () => {
  const projected = projectReliableConversation({
    conversationId: 'parent-conversation',
    details: {},
    records: {
      Turn: {
        parent: { id: 'parent-turn', conversation_id: 'parent-conversation', status: 'active' },
        unrelated: { id: 'other-turn', conversation_id: 'other-conversation', status: 'active' }
      },
      ChildExecution: {
        child: { id: 'child-execution', child_conversation_id: 'child-conversation', status: 'active' },
        unrelated: { id: 'other-child', child_conversation_id: 'other-child-conversation', status: 'active' }
      },
      ChildExecutionParentLink: {
        child: { id: 'child-link', child_execution_id: 'child-execution', parent_turn_id: 'parent-turn', source_tool_call_id: 'run-agent-tool' },
        unrelated: { id: 'other-link', child_execution_id: 'other-child', parent_turn_id: 'other-turn', source_tool_call_id: 'other-tool' }
      }
    }
  });
  assert.deepEqual(projected.childConversationIdByToolCallId, {
    'run-agent-tool': 'child-conversation'
  });

});


test('parent feed receives a bounded child activity change without child ToolCall leakage', async () => {
  const kernel = require(path.join(root, 'dist/extension/backend/reliableKernel/index.js'));
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'limcode-child-activity-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const app = await kernel.ReliableKernelApplication.open(authority, runtimeDependencies());
  try {
    const conversationId = 'child-activity-parent';
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: 'Child activity parent',
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'child-activity-parent-agent-link',
        conversation_id: conversationId,
        agent_id: 'agent-main',
        role: 'default',
        created_at: now,
        updated_at: now
      })
    ]);
    const parentTurn = await app.turns.input({
      source: { kind: 'command', key: 'child-activity-parent-input' },
      conversationId,
      leaseOwnerId: 'child-activity-parent-owner',
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'delegate work'
    });
    await app.runtime.effects.createToolCall({
      source: { kind: 'internal', key: 'child-activity-run-agent-call' },
      toolCallId: 'child-activity-run-agent-call',
      turnId: parentTurn.turnId,
      toolName: 'run_agent',
      arguments: { operation: 'spawn', taskName: 'Inspect workspace activity', prompt: 'inspect the workspace' }
    });
    const child = await app.runtime.children.spawn({
      sourceToolCallId: 'child-activity-run-agent-call',
      childAgentId: 'agent-child',
      modelFallback: {
        providerConfigId: 'provider-local',
        provider: 'openai-compatible',
        model: 'model-local'
      },
      sourceSettlement: 'child_handle',
      prompt: 'inspect the workspace',
      completionPolicy: 'wait_for_answer',
      waitDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      leaseOwnerId: `child-driver:${app.database.hostBootId}`,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
    });

    const posted = [];
    const connection = await app.runtime.clientFeed.connect({
      activeConversationId: conversationId,
      send(message) { posted.push(message); }
    });
    const snapshot = posted[0];
    assert.equal(snapshot.type, 'reliable-kernel.snapshot');
    assert.equal(
      snapshot.projections.subagentDeliverySummary.childExecutionActivities[0]?.child_execution_id,
      child.childExecutionId
    );
    app.runtime.clientFeed.acknowledge({
      sessionId: connection.sessionId,
      hostBootId: connection.hostBootId,
      messageSeq: snapshot.messageSeq
    });

    await app.runtime.effects.createToolCall({
      source: { kind: 'internal', key: 'child-activity-shell-call' },
      toolCallId: 'child-activity-shell-call',
      turnId: child.childTurnId,
      toolName: 'shell',
      arguments: { command: 'npm test -- --runInBand' }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const update = posted.at(-1);
    assert.equal(update.type, 'reliable-kernel.changes');
    assert.equal(update.changes.some((change) => change.type === 'ToolCall'), false);
    const activity = update.changes.find((change) => change.type === 'ChildExecutionActivity');
    assert.equal(activity?.record?.child_execution_id, child.childExecutionId);
    assert.equal(activity?.record?.kind, 'tool');
    assert.match(activity?.record?.summary ?? '', /等待运行命令.*npm test -- --runInBand/);
  } finally {
    await app.close();
    await fsPromises.rm(parent, { recursive: true, force: true });
  }
});

function runtimeDependencies() {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: 'provider-local', modelId: 'model-local' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              executorAgentId: request.executorAgentId,
              modelProfile: {
                compressionThresholdTokens: 100000,
                contextWindowTokens: 128000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              model: { providerConfigId: 'provider-local', provider: 'openai-compatible', modelId: 'model-local' },
              policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { return null; }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return {
          section: 'attachments',
          settings: { maxStoredInlineFileMb: 25 },
          filePath: 'settings/attachments.json'
        };
      }
    },
    providers: {
      resolve(providerId) {
        return {
          providerId,
          async sendFullRequest() { throw new Error('fixture provider was not configured'); }
        };
      }
    },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('fixture tool dispatcher was not configured'); }
    }
  };
}

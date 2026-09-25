const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = process.cwd();
const extensionDist = process.env.LIMCODE_EXTENSION_DIST
  ? path.resolve(process.env.LIMCODE_EXTENSION_DIST)
  : path.join(root, 'dist/extension');

function fromDist(relativePath) {
  return require(path.join(extensionDist, relativePath));
}

const { ReliableChildAgentCoordinator } = fromDist('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableToolDispatcher } = fromDist('backend/reliableKernel/toolDispatcher.js');
const { stablePhaseFId } = fromDist('backend/reliableKernel/phaseFIdentity.js');
const {
  DEFAULT_MAX_CHILD_AGENT_DEPTH,
  MAX_CHILD_AGENT_DEPTH_CONFIG_KEY,
  maxChildAgentDepthFromConfig,
  runAgentToolAvailableAtDepth,
  runAgentTool
} = fromDist('backend/world/modules/tools/definitions/runAgent/index.js');
const { readAgentAnswerTool } = fromDist('backend/world/modules/tools/definitions/agentAnswer/index.js');
const { deleteTool } = fromDist('backend/world/modules/tools/definitions/delete/index.js');

test('Agent 工具声明要求显式操作，异步派发与既有任务操作分开', () => {
  assert.match(runAgentTool.declaration.description, /spawn/);
  assert.match(runAgentTool.declaration.description, /send/);
  assert.match(runAgentTool.declaration.description, /answerBridgeId/);
  assert.match(runAgentTool.declaration.description, /queues after the current child turn/);
  assert.equal(runAgentTool.declaration.parameters.properties.interrupt.type, 'boolean');
  assert.equal(runAgentTool.declaration.parameters.properties.taskName.type, 'string');
  assert.equal(runAgentTool.declaration.parameters.properties.foregroundWaitMs.type, 'integer');
  assert.equal(runAgentTool.declaration.parameters.properties.foregroundWaitMs.minimum, 0);
  assert.equal(runAgentTool.declaration.parameters.properties.foregroundWaitMs.maximum, 86_400_000);
  assert.equal(runAgentTool.declaration.parameters.properties.foregroundWaitMs.multipleOf, undefined);

  assert.deepEqual(runAgentTool.declaration.parameters.required, ['operation'],
    '所有调用必须说明操作，spawn/send 的条件参数由执行器校验，list 不要求 prompt');
  assert.deepEqual(runAgentTool.declaration.parameters.properties.operation.enum,
    ['spawn', 'send', 'list', 'read', 'wait', 'interrupt_subtree']);
  assert.equal(runAgentTool.declaration.parameters.properties.mode, undefined,
    '旧 mode 不再进入模型工具合同');
  assert.deepEqual(readAgentAnswerTool.declaration.parameters.required, ['answerBridgeId']);
  assert.deepEqual(deleteTool.declaration.parameters.required, ['paths']);

  const depthField = runAgentTool.declaration.configSchema.fields.find(
    (field) => field.key === MAX_CHILD_AGENT_DEPTH_CONFIG_KEY
  );
  assert.ok(depthField);
  assert.equal(depthField.type, 'number');
  assert.equal(depthField.defaultValue, 1);
  assert.equal(DEFAULT_MAX_CHILD_AGENT_DEPTH, 1);
  assert.equal(runAgentTool.declaration.defaultConfig[MAX_CHILD_AGENT_DEPTH_CONFIG_KEY], 1);
  assert.equal(runAgentTool.declaration.parameters.properties[MAX_CHILD_AGENT_DEPTH_CONFIG_KEY], undefined,
    '嵌套层级是工具策略，不应暴露给模型当调用参数');
  assert.equal(maxChildAgentDepthFromConfig({ [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: 2.9 }), 2);
  assert.equal(maxChildAgentDepthFromConfig({ [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: -3 }), 0);
  assert.equal(maxChildAgentDepthFromConfig({ [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: 'invalid' }), 1);
  assert.equal(runAgentToolAvailableAtDepth(0, { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: 3 }), true);
  assert.equal(runAgentToolAvailableAtDepth(1, { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: 3 }), true);
  assert.equal(runAgentToolAvailableAtDepth(2, { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: 3 }), true);
  assert.equal(runAgentToolAvailableAtDepth(3, { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: 3 }), false);
  assert.equal(runAgentToolAvailableAtDepth(4, { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: 3 }), false);
  assert.equal(runAgentToolAvailableAtDepth(0, { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: 0 }), false);
});

test('可靠 run_agent 省略 foregroundWaitMs 时立即转后台，spawn 与 interrupt_subtree 的 prompt 校验保持分开', async () => {
  const toolCallId = 'optional-wait-tool-call';
  const answerBridgeId = stablePhaseFId('answer_bridge', toolCallId);
  let spawnCommand;
  let resolvedSelection;
  let initializedModel;
  const coordinator = new ReliableChildAgentCoordinator({
    database: {
      hostBootId: 'optional-wait-host',
      conversationOwners: createRetainedConversationOwners(),
      async snapshot(reads) {
        return {
          snapshot: reads.map((read) => {
            if (read.kind === 'list') return [];
            if (read.domain === 'Turn' && read.id === 'parent-turn') {
              return { id: read.id, conversation_id: 'parent-conversation', status: 'active' };
            }
            if (read.domain === 'ToolCall') return { id: read.id, turn_id: 'parent-turn' };
            return null;
          })
        };
      }
    },
    effects: {
      async settleWithoutEffect(input) {
        return { status: input.status };
      }
    },
    children: {
      async spawn(command) {
        spawnCommand = command;
        return {
          answerBridgeId,
          effectIntentId: 'spawn-effect',
          attemptId: 'spawn-attempt',
          childExecutionId: 'spawn-child',
          childConversationId: 'spawn-conversation',
          childTurnId: 'spawn-turn',
          modelSelection: {
            providerConfigId: 'provider-parent',
            provider: 'openai-compatible',
            model: 'model-parent'
          }
        };
      },
      async claimSpawnDispatch() { return true; },
      async recordSpawnReceipt() { return { effectReceiptId: 'spawn-receipt' }; },
      async reconcileSpawnReceipt() {},
      async finalizeWaitSettlement(requestedToolCallId) {
        return { toolCallId: requestedToolCallId, status: 'succeeded' };
      },
      async readConversationTaskProjection(conversationId) {
        assert.equal(conversationId, 'parent-conversation');
        return {
          conversationId,
          revision: 'fixture-child-task-revision',
          snapshotCommitSeq: '1',
          tasks: ['continuation', 'interrupt'].map((kind) => ({
            childExecutionId: `${kind}-child`,
            answerBridgeId: `${kind}-bridge`,
            parentConversationId: conversationId,
            conversationId: `${kind}-conversation`,
            depth: 1
          }))
        };
      },
      async readExecutionSnapshot(childExecutionId) {
        return {
          childExecution: {
            id: childExecutionId,
            status: 'idle',
            child_conversation_id: childExecutionId.replace('-child', '-conversation')
          }
        };
      },
      async send() {
        return { turnIntentId: 'continuation-intent' };
      },
      async admitQueuedIntent(command) {
        return { childExecutionId: command.childExecutionId, turnId: 'continuation-turn' };
      },
      async interruptSubtree() {
        return {
          rootChildExecutionId: 'interrupt-child',
          activeTurnIds: [],
          cancelledIntentIds: []
        };
      }
    },
    answers: {},
    deliveries: {},
    modelProvider: {},
    turns: {},
    agentLoop: finalOutputObserverHost(),
    agents: {
      async resolve(selection) {
        resolvedSelection = selection;
        return { agentId: 'agent-child', agentType: 'worker' };
      }
    },
    modelProfiles: {
      async initializeConversation(input) {
        initializedModel = input;
        return { created: true };
      }
    }
  });
  coordinator.launch = () => {};

  const background = await coordinator.dispatch({
    turnId: 'parent-turn',
    modelRequestId: 'parent-request',
    toolCallId,
    toolName: 'run_agent',
    arguments: { operation: 'spawn', taskName: 'Inspect background behavior', prompt: 'inspect in the background', agent: { type: 'worker' } }
  }, undefined, frozenRunAgentAuthority(1));
  assert.deepEqual(resolvedSelection, { agentType: 'worker' });
  assert.equal(spawnCommand.completionPolicy, 'background');
  assert.equal('waitDeadlineAt' in spawnCommand, false);
  assert.deepEqual(spawnCommand.modelFallback, {
    providerConfigId: 'provider-parent',
    provider: 'openai-compatible',
    model: 'model-parent'
  });
  assert.deepEqual(initializedModel, {
    conversationId: 'spawn-conversation',
    model: spawnCommand.modelFallback
  });
  assert.match(spawnCommand.prompt, /inspect in the background/);
  assert.doesNotMatch(spawnCommand.prompt, /answer_bridge_[a-f0-9]{64}/);
  assert.equal(spawnCommand.prompt.includes(answerBridgeId), false, '子提示不得泄漏 canonical AnswerBridge ID');
  assert.equal(background.disposition, 'settled');

  await assert.rejects(() => coordinator.dispatch({
    turnId: 'parent-turn',
    modelRequestId: 'missing-prompt-request',
    toolCallId: 'missing-prompt-tool-call',
    toolName: 'run_agent',
    arguments: { operation: 'spawn', taskName: 'Validate missing prompt' }
  }), /run_agent\.prompt must be non-empty/);

  const maxZeroAuthority = frozenRunAgentAuthority(0);
  const continued = await coordinator.dispatch({
    turnId: 'parent-turn',
    modelRequestId: 'continuation-request',
    toolCallId: 'continuation-tool-call',
    toolName: 'run_agent',
    arguments: {
      operation: 'send',
      prompt: 'continue the same child',
      answerBridgeId: 'continuation-bridge'
    }
  }, undefined, maxZeroAuthority);
  assert.equal(continued.disposition, 'settled',
    'answerBridgeId 续发不创建子 Agent，即使上限为 0 也应允许');

  const interrupted = await coordinator.dispatch({
    turnId: 'parent-turn',
    modelRequestId: 'interrupt-request',
    toolCallId: 'interrupt-tool-call',
    toolName: 'run_agent',
    arguments: { operation: 'interrupt_subtree', answerBridgeId: 'interrupt-bridge' }
  }, undefined, maxZeroAuthority);
  assert.equal(interrupted.disposition, 'settled');
});

test('可靠 run_agent 按冻结策略和持久父链限制新建子 Agent 的层级', async () => {
  const rootBlocked = createDepthCoordinator([]);
  await assert.rejects(() => rootBlocked.coordinator.dispatch(
    runAgentInput('root-blocked'),
    undefined,
    frozenRunAgentAuthority(0)
  ), /当前对话是第 0 层.*第 1 层.*上限是 0/);
  assert.equal(rootBlocked.spawnCount(), 0);
  assert.equal(rootBlocked.resolveCount(), 0, '超限时不应先创建或解析子 Agent');

  const firstLevelBlocked = createDepthCoordinator(['child-level-1']);
  await assert.rejects(() => firstLevelBlocked.coordinator.dispatch(
    runAgentInput('nested-blocked')
  ), /当前对话是第 1 层.*第 2 层.*上限是 1/);
  assert.equal(firstLevelBlocked.spawnCount(), 0);

  const firstLevelAllowed = createDepthCoordinator(['child-level-1']);
  const allowed = await firstLevelAllowed.coordinator.dispatch(
    runAgentInput('nested-allowed'),
    undefined,
    frozenRunAgentAuthority(2)
  );
  assert.equal(allowed.disposition, 'settled');
  assert.equal(firstLevelAllowed.spawnCount(), 1);
});

test('达到深度上限只移除 spawn，模型仍能查询和操作已有子 Agent', async () => {
  for (const [maxDepth, lineage, spawnAllowed] of [
    [3, [], true],
    [3, ['child-1'], true],
    [3, ['child-2', 'child-1'], true],
    [3, ['child-3', 'child-2', 'child-1'], false],
    [3, ['child-4', 'child-3', 'child-2', 'child-1'], false],
    [0, [], false]
  ]) {
    const definitions = await visibleToolDefinitions(maxDepth, lineage);
    assert.deepEqual(definitions.map((definition) => definition.name).sort(), ['read', 'run_agent']);
    const childTool = definitions.find((definition) => definition.name === 'run_agent');
    assert.deepEqual(childTool.parameters.properties.operation.enum,
      spawnAllowed ? ['spawn', 'send', 'list', 'read', 'wait', 'interrupt_subtree']
        : ['send', 'list', 'read', 'wait', 'interrupt_subtree']);
  }
});

test('Child Turn 在 active drive 期间收到唤醒时不会丢失 waiting 后的重驱动', { timeout: 10_000 }, async () => {
  const hostBootId = 'wake-race-host';
  const childExecutionId = 'wake-race-child';
  const childConversationId = 'wake-race-conversation';
  const turnId = 'wake-race-turn';
  let driveCalls = 0;
  let releaseFirstDrive;
  let signalFirstDriveStarted;
  let signalSecondDriveStarted;
  const firstDriveGate = new Promise((resolve) => { releaseFirstDrive = resolve; });
  const firstDriveStarted = new Promise((resolve) => { signalFirstDriveStarted = resolve; });
  const secondDriveStarted = new Promise((resolve) => { signalSecondDriveStarted = resolve; });
  // Fixture regressions must fail fast instead of parking the whole test run on a stuck gate.
  const bounded = (promise, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 1_000);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
  const coordinator = new ReliableChildAgentCoordinator({
    database: {
      hostBootId,
      conversationOwners: createRetainedConversationOwners(),
      async snapshot(reads) {
        return {
          snapshot: reads.map((read) => {
            if (read.kind === 'list') {
              return read.domain === 'ChildExecutionTurnLink'
                ? [{
                    id: 'wake-race-membership',
                    turn_id: turnId,
                    child_execution_id: childExecutionId
                  }]
                : [];
            }
            if (read.domain === 'ChildExecution' && read.id === childExecutionId) {
              return {
                id: childExecutionId,
                status: 'active',
                child_conversation_id: childConversationId
              };
            }
            if (read.domain === 'Turn' && read.id === turnId) {
              return { id: turnId, status: 'active', conversation_id: childConversationId };
            }
            return null;
          })
        };
      },
      async externalDataVersion() { return '1'; }
    },
    effects: {},
    children: {},
    answers: {},
    deliveries: {},
    modelProvider: {
      async quiesceTurnDispatches() {}
    },
    turns: {
      async ownsExecutionLease() { return true; },
      async executionLeaseFence() {
        return {
          id: 'wake-race-lease',
          conversationId: childConversationId,
          turnId,
          ownerId: `child-driver:${hostBootId}`,
          hostBootId,
          generation: 1n
        };
      },
      async renewExecutionLease() { return true; }
    },
    agentLoop: {
      ...finalOutputObserverHost(),
      async drive(requestedTurnId) {
        driveCalls += 1;
        if (driveCalls === 1) {
          signalFirstDriveStarted();
          await firstDriveGate;
        } else {
          signalSecondDriveStarted();
        }
        return {
          turnId: requestedTurnId,
          terminalStatus: 'waiting',
          modelRequestIds: [],
          assistantMessageIds: [],
          toolCallIds: []
        };
      }
    },
    agents: {},
    modelProfiles: {
      async initializeConversation() { return { created: false }; }
    }
  });

  coordinator.launch(childExecutionId, turnId);
  await bounded(firstDriveStarted, '首个 Child drive 未能在 1s 内进入');
  assert.equal(await coordinator.resume(turnId), true);
  releaseFirstDrive();
  await bounded(secondDriveStarted, 'active drive 期间的 Child 唤醒被丢失');
  await coordinator.waitForIdle();
  assert.equal(driveCalls, 2);
  await coordinator.dispose();
});

/** The agent-loop surface a child coordinator subscribes to: final outputs of child Turns. */
function finalOutputObserverHost() {
  const observers = new Set();
  return {
    registerFinalOutputObserver(observer) {
      observers.add(observer);
      return () => { observers.delete(observer); };
    }
  };
}

function frozenRunAgentAuthority(maxDepth) {
  return {
    snapshotId: `authority-depth-${maxDepth}`,
    document: {
      model: {
        providerConfigId: 'provider-parent',
        provider: 'openai-compatible',
        modelId: 'model-parent'
      }
    },
    toolConfig: {
      config: { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: maxDepth }
    }
  };
}

/**
 * Mandatory RuntimeDatabase owner manager reduced to a single current-Host model: every claim
 * succeeds and ownership stays retained for the rest of the test, so coordinator drives always
 * pass the ownership gate. Cross-Host contention itself is covered by the real Runtime suite.
 */
function createRetainedConversationOwners() {
  const owned = new Set();
  return {
    owns(conversationId) {
      return owned.has(conversationId);
    },
    async claim(conversationId) {
      owned.add(conversationId);
    },
    async tryClaim(conversationId) {
      owned.add(conversationId);
      return true;
    },
    async assertOwned(conversationId) {
      if (!owned.has(conversationId)) {
        throw new Error(`Conversation ${conversationId} is not owned by this Runtime Host.`);
      }
    },
    async run(conversationId, operation) {
      owned.add(conversationId);
      return operation();
    },
    async releaseIfIdle() {
      return false;
    }
  };
}

function runAgentInput(suffix) {
  return {
    turnId: `parent-turn-${suffix}`,
    modelRequestId: `parent-request-${suffix}`,
    toolCallId: `tool-call-${suffix}`,
    toolName: 'run_agent',
    arguments: { operation: 'spawn', taskName: `Inspect ${suffix}`, prompt: `task-${suffix}`, agent: { type: 'worker' } }
  };
}

function createDepthCoordinator(lineageFromCurrentToRoot) {
  let spawns = 0;
  let resolutions = 0;
  const coordinator = new ReliableChildAgentCoordinator({
    database: {
      hostBootId: 'depth-host',
      conversationOwners: createRetainedConversationOwners(),
      async snapshot(reads) {
        return {
          snapshot: reads.map((read) => {
            if (read.kind !== 'list') return null;
            if (read.domain === 'ChildExecutionTurnLink') {
              return lineageFromCurrentToRoot.length === 0
                ? []
                : [{
                    id: `turn-link-${lineageFromCurrentToRoot[0]}`,
                    turn_id: read.where.turn_id,
                    child_execution_id: lineageFromCurrentToRoot[0]
                  }];
            }
            if (read.domain === 'ChildExecutionParentLink' && read.where.child_execution_id) {
              const index = lineageFromCurrentToRoot.indexOf(read.where.child_execution_id);
              assert.notEqual(index, -1, '测试父链必须是连续的');
              return [{
                id: `parent-link-${lineageFromCurrentToRoot[index]}`,
                child_execution_id: lineageFromCurrentToRoot[index],
                parent_child_execution_id: lineageFromCurrentToRoot[index + 1] ?? null
              }];
            }
            if (read.domain === 'ChildExecutionParentLink' && read.where.source_tool_call_id) return [];
            return [];
          })
        };
      }
    },
    effects: {},
    children: {
      async spawn(command) {
        spawns += 1;
        return {
          answerBridgeId: stablePhaseFId('answer_bridge', command.sourceToolCallId),
          effectIntentId: 'depth-spawn-effect',
          attemptId: 'depth-spawn-attempt',
          childExecutionId: 'depth-spawn-child',
          childConversationId: 'depth-spawn-conversation',
          childTurnId: 'depth-spawn-turn',
          modelSelection: {
            providerConfigId: 'provider-parent',
            provider: 'openai-compatible',
            model: 'model-parent'
          }
        };
      },
      async claimSpawnDispatch() { return true; },
      async recordSpawnReceipt() { return { effectReceiptId: 'depth-spawn-receipt' }; },
      async reconcileSpawnReceipt() {},
      async finalizeWaitSettlement(toolCallId) {
        return { toolCallId, status: 'succeeded' };
      }
    },
    answers: {},
    deliveries: {},
    modelProvider: {},
    turns: {},
    agentLoop: finalOutputObserverHost(),
    agents: {
      async resolve() {
        resolutions += 1;
        return { agentId: 'depth-agent', agentType: 'worker' };
      }
    },
    modelProfiles: {
      async initializeConversation() { return { created: true }; }
    }
  });
  coordinator.launch = () => {};
  return {
    coordinator,
    spawnCount: () => spawns,
    resolveCount: () => resolutions
  };
}

async function visibleToolDefinitions(maxDepth, lineageFromCurrentToRoot) {
  const database = {
    async snapshot(reads) {
      return {
        snapshot: reads.map((read) => {
          if (read.kind !== 'list') return null;
          if (read.domain === 'ChildExecutionTurnLink') {
            return lineageFromCurrentToRoot.length === 0
              ? []
              : [{
                  id: `visibility-turn-link-${lineageFromCurrentToRoot[0]}`,
                  turn_id: read.where.turn_id,
                  child_execution_id: lineageFromCurrentToRoot[0]
                }];
          }
          if (read.domain === 'ChildExecutionParentLink') {
            const index = lineageFromCurrentToRoot.indexOf(read.where.child_execution_id);
            assert.notEqual(index, -1, '工具可见性测试父链必须连续');
            return [{
              id: `visibility-parent-link-${lineageFromCurrentToRoot[index]}`,
              child_execution_id: lineageFromCurrentToRoot[index],
              parent_child_execution_id: lineageFromCurrentToRoot[index + 1] ?? null
            }];
          }
          return [];
        })
      };
    }
  };
  const dispatcher = new ReliableToolDispatcher({
    database,
    contentStore: {},
    effects: { subscribeToolModelResults: () => () => undefined },
    files: {},
    fileMutations: {},
    processes: {},
    mcp: {},
    interactions: {},
    host: {
      definitions() {
        return [runAgentTool, {
          execution: 'runtime',
          declaration: {
            name: 'read',
            description: 'read fixture',
            parameters: {},
            metadata: { defaultEnabled: true }
          },
          async execute() { return { ok: true }; }
        }];
      }
    }
  });
  dispatcher.readAuthority = async () => ({
    snapshotId: `visibility-authority-${maxDepth}`,
    document: {
      toolPolicy: {
        allowedTools: ['read', 'run_agent'],
        preset: 'custom',
        toolConfigs: {
          run_agent: { config: { [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: maxDepth } }
        },
        sourceConfigs: {}
      },
      workEnvironmentPolicy: {
        enabled: true,
        allowedWorkEnvironmentIds: [],
        defaultWorkEnvironmentId: null
      }
    }
  });
  return dispatcher.definitions('visibility-turn');
}

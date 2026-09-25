/**
 * 压缩后重新附上已载入的技能（参照 Claude Code：按最近载入排序、按技能名去重，每个技能最多保留开头约 5K，
 * 总量受额度限制）。真实内核：Agent 循环、工具结算、Context 写入、压缩协调器与完整请求适配器都是生产代码，
 * 只有外部模型是脚本。技能正文取自已提交的工具结果，重算得到同样的字节；仍留在未压缩尾巴里的载入不重复附上；
 * 链式压缩把上次附上的技能原样带过去，摘要输入只拿到技能名，不再拿到正文；Provider 原生压缩之后同样附上。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = (file) => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const capabilitiesModule = load('shared/modelCapabilities.js');
const { renderLoadedSkill } = load('backend/world/modules/skill/skillLookup.js');
const { dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');
const {
  SKILL_REATTACHMENT_HEADER,
  SKILL_REATTACHMENT_PER_SKILL_TOKENS,
  isSkillReattachmentContent,
  planSkillReattachment
} = load('backend/reliableKernel/skillToolResultProjection.js');
const { estimateTextTokens } = load('backend/reliableKernel/modelTokenEstimator.js');

const THRESHOLD = 150_000;
/** About 8K tokens: whole in the tool result (its own 25K allowance), shortened when re-attached. */
const BODY = Array.from({ length: 700 }, (_, index) =>
  `${index + 1}. Step ${index + 1}: run "check-${index + 1}" and record its "result" before the next step.`).join('\n');
const SKILL = { name: 'demo', source: '.claude', baseDirectory: '/skills/demo', entryPath: '/skills/demo/SKILL.md', body: BODY, bodyStartLine: 4 };
const RENDERED = renderLoadedSkill(SKILL, BODY);

function providerFor(method) {
  return method === 'provider_native'
    ? { providerConfigId: 'responses-fixture', provider: 'openai-responses', modelId: 'gpt-5.5', baseUrl: 'https://api.openai.com/v1' }
    : { providerConfigId: 'chat-fixture', provider: 'openai-compatible', modelId: 'chat-model', baseUrl: 'https://chat.invalid/v1' };
}

function authorityCompiler(method) {
  const provider = providerFor(method);
  const resolved = capabilitiesModule.resolveModelCapabilities({
    provider: provider.provider, baseUrl: provider.baseUrl, modelId: provider.modelId,
    providerConfigId: provider.providerConfigId, transport: 'http'
  });
  const capabilities = method === 'provider_native'
    ? { ...resolved, nativeCompaction: { kind: 'openai_responses', availability: 'verified', reason: 'fixture' } }
    : resolved;
  const executionPlan = capabilitiesModule.resolveCompressionExecutionPlan({ kind: method, fallbacks: [] }, capabilities);
  assert.equal(executionPlan.attempts[0]?.methodKind, method);
  const summaryReasoning = capabilitiesModule.resolveSummaryReasoning({ mode: 'provider_default', capabilities });
  const trigger = { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: THRESHOLD };
  return {
    async compile(request) {
      return {
        turnId: request.turnId,
        executorAgentId: request.executorAgentId,
        executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerConfigId, modelId: provider.modelId }) },
        authoritySnapshot: { content: JSON.stringify({
          kind: 'effective-turn-authority', turnId: request.turnId, conversationId: request.conversationId,
          executorAgentId: request.executorAgentId,
          model: { providerConfigId: provider.providerConfigId, provider: provider.provider, modelId: provider.modelId },
          modelProfile: {
            compressionThresholdTokens: THRESHOLD, contextWindowTokens: 200_000,
            tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
          },
          compression: {
            enabled: true, methodKind: method, executionPlan, thresholdTokens: THRESHOLD,
            config: { id: `compression-${method}`, name: method, kind: method, trigger },
            provider: {
              providerConfigId: provider.providerConfigId, provider: provider.provider, modelId: provider.modelId,
              capabilities, summaryReasoning, contextWindowTokens: 200_000, maxOutputTokens: 16_000
            }
          },
          toolPolicy: { id: 'tools', allowedTools: ['skills'], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
          systemPrompt: { id: 'prompt', text: 'Fixture agent.' },
          runtimeContext: { id: null, name: '', template: '' },
          workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
        }) }
      };
    }
  };
}

function wireSettings(method) {
  const provider = providerFor(method);
  return {
    id: provider.providerConfigId, name: provider.providerConfigId, provider: provider.provider, baseUrl: provider.baseUrl,
    model: provider.modelId, models: [{ id: provider.modelId, name: provider.modelId }], apiKey: '',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true, retryOnError: false, retryMaxAttempts: 0,
    retryDelaySeconds: 0, enableMultimodalTools: true, contextWindowTokens: 200_000, modelConfigs: [], createdAt: 1, updatedAt: 1
  };
}

const COMPACTION_ITEM = { role: 'model', parts: [{ providerContext: {
  provider: 'openai', format: 'openai-responses', itemType: 'compaction',
  rawItem: { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'gAAAA-fixture-ciphertext' }
} }] };

async function withRuntime(method, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-skill-reattachment-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const ordinary = [];
  const compressions = [];
  let app;
  app = await kernel.ReliableKernelApplication.open(authority, {
    authorityCompiler: authorityCompiler(method),
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
    mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: { resolve(providerId) {
      return { providerId, async sendFullRequest(request, controls) {
        if (request.recipe.kind === 'reliable-context-compression') {
          compressions.push({
            request,
            ...(method === 'provider_native' ? {} : { compact: kernel.compactRequestForCompressionPlanning(request) })
          });
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: {
            type: 'compression_result',
            contents: method === 'provider_native'
              ? [COMPACTION_ITEM]
              : [{ role: 'user', parts: [{ text: `[Context Summary]\n\nSUMMARY-${compressions.length}` }] }]
          } });
          return;
        }
        let start;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { start = structuredClone(input); emit({ type: 'llm:done', payload: { requestId: input.id } }); },
          abort() {}, cancelRetry() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, checkpointed: true, terminal: false }; } });
        const wire = (await dryRunLlmProvider(start, { settings: async () => wireSettings(method) })).body;
        ordinary.push({ request, start, wire });
        const parts = ordinary.length === 1
          ? [{ id: 'call_skill', functionCall: { name: 'skills', args: { name: 'demo' } } }]
          : [{ text: `reply ${ordinary.length}` }];
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts } });
      } };
    } },
    toolDispatcher: {
      definitions() {
        return [{ name: 'skills', description: 'Load a skill', parameters: { type: 'object', properties: { name: { type: 'string' } } } }];
      },
      async dispatch(input) {
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `fixture:${input.toolCallId}` }, toolCallId: input.toolCallId, status: 'succeeded',
          detail: { ok: true, output: SKILL }
        });
        return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
      }
    }
  });
  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'skills', title: 'Skills', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'skills-agent', conversation_id: 'skills', agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now
      })
    ]);
    await run({ app, ordinary, compressions });
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 200
  }))).snapshot;
}

async function input(app, text) {
  const started = await app.turns.input({
    source: { kind: 'command', key: `skills:${text}` }, conversationId: 'skills', leaseOwnerId: 'skills-owner',
    hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: text
  });
  const [snapshot] = await rows(app, 'AuthoritySnapshot', { turn_id: started.turnId });
  return { turnId: started.turnId, authoritySnapshotId: snapshot.id };
}

async function drive(app, turnId) {
  const [lease] = await rows(app, 'ExecutionLease', { turn_id: turnId });
  const result = await kernel.runWithExecutionLeaseFence({
    id: lease.id, conversationId: 'skills', turnId, ownerId: lease.owner_id,
    hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
  }, () => app.agentLoop.drive(turnId));
  assert.equal(result.terminalStatus, 'completed', JSON.stringify(await rows(app, 'TurnTermination', { turn_id: turnId })));
}

async function compress(app, turn, compressSegmentCount) {
  const result = await app.compressionCoordinator.coordinate({
    turnId: turn.turnId, authoritySnapshotId: turn.authoritySnapshotId,
    headRootId: await app.context.currentHeadRootId('skills'), trigger: 'manual',
    ...(compressSegmentCount === undefined ? {} : { compressSegmentCount })
  });
  assert.equal(result.status, 'compressed', JSON.stringify(result));
  const [block] = await rows(app, 'CompressionBlock', { id: result.result.compressionBlockId });
  const [object] = await rows(app, 'ContentObject', { id: block.summary_object_id });
  return JSON.parse((await app.contentStore.read(object)).toString('utf8')).contents;
}

async function recordCount(app) {
  return (await app.context.materializeStructure(await app.context.currentHeadRootId('skills'))).records.length;
}

const reattachmentOf = (contents) => contents.filter(isSkillReattachmentContent);
const userTexts = (start) => start.contents.flatMap((content) => content.role === 'user'
  ? content.parts.flatMap((part) => typeof part.text === 'string' ? [part.text] : [])
  : []);

test('文本摘要压缩掉技能载入后，从已提交的工具结果重新附上技能开头，下一次请求原文可见；链式压缩原样带过去', { timeout: 120_000 }, async () => {
  await withRuntime('llm_summary', async ({ app, ordinary, compressions }) => {
    const first = await input(app, 'load the demo skill');
    await drive(app, first.turnId);
    // Turn 1, request 2: the loaded skill is whole (its own 25K allowance) and plain text on the wire.
    const toolMessage = ordinary[1].wire.messages.find((message) => message.role === 'tool');
    assert.equal(toolMessage.content, RENDERED);

    const second = await input(app, 'continue with the skill');
    const contents = await compress(app, second, (await recordCount(app)) - 1);
    const [reattachment] = reattachmentOf(contents);
    assert.ok(reattachment, 'the compressed skill load is re-attached after the summary');
    assert.equal(contents.at(-1), reattachment);
    assert.match(contents[0].parts[0].text, /SUMMARY-1/);
    assert.ok(reattachment.parts[0].text.startsWith(`${SKILL_REATTACHMENT_HEADER}\n`));
    assert.match(reattachment.parts[0].text, /still apply/);
    const skillText = reattachment.parts[1].text;
    assert.ok(skillText.startsWith('<skill name="demo" source=".claude">\nBase directory for this skill: /skills/demo\n'));
    assert.ok(estimateTextTokens(skillText) <= SKILL_REATTACHMENT_PER_SKILL_TOKENS);
    assert.match(skillText, /Re-attached after context compression and shortened: lines 1-\d+ of the skill body \(700 lines\)/);
    assert.match(skillText, /rereadHint: \{"kind":"file","path":"\/skills\/demo\/SKILL\.md","startLine":\d+\}/);
    assert.equal(compressions[0].request.recipe.skillReattachmentBudgetTokens, 12_000, 'a quarter of the 48K body target');

    // The next ordinary request reads the re-attached skill as text right after the summary.
    await drive(app, second.turnId);
    const afterFirst = ordinary.at(-1);
    const texts = userTexts(afterFirst.start);
    assert.ok(texts.some((text) => text.includes('SUMMARY-1')));
    assert.ok(texts.includes(skillText));
    assert.ok(afterFirst.wire.messages.some((message) => message.role === 'user'
      && JSON.stringify(message.content).includes(JSON.stringify(skillText).slice(1, 200))));

    // Chained compression: the earlier re-attachment is inside the compressed prefix and is carried over
    // verbatim; the summary writer gets only the skill name, not the body again.
    const third = await input(app, 'next step');
    const chained = await compress(app, third, (await recordCount(app)) - 1);
    const [carried] = reattachmentOf(chained);
    assert.ok(carried);
    assert.equal(carried.parts[1].text, skillText);
    const prior = JSON.stringify(compressions[1].compact.priorSummaryContents);
    assert.match(prior, /Skills loaded earlier in this conversation: demo/);
    assert.equal(prior.includes('Step 1: run'), false, 'the skill body is not summarized again');
  });
});

test('技能载入仍在未压缩尾巴里时不重复附上', { timeout: 120_000 }, async () => {
  await withRuntime('llm_summary', async ({ app }) => {
    const first = await input(app, 'load the demo skill');
    await drive(app, first.turnId);
    const second = await input(app, 'continue');
    const contents = await compress(app, second, 1);
    assert.equal(reattachmentOf(contents).length, 0);
    assert.equal(contents.length, 1);
  });
});

test('Provider 原生压缩之后，内核在压缩项后面附上技能；下一次 Responses 请求紧跟压缩项读到原文', { timeout: 120_000 }, async () => {
  await withRuntime('provider_native', async ({ app, ordinary }) => {
    const first = await input(app, 'load the demo skill');
    await drive(app, first.turnId);
    const output = ordinary[1].wire.input.find((item) => item.type === 'function_call_output');
    assert.equal(output.output, RENDERED);

    const second = await input(app, 'continue with the skill');
    const contents = await compress(app, second);
    assert.deepEqual(contents[0], COMPACTION_ITEM);
    const [reattachment] = reattachmentOf(contents);
    assert.equal(contents.at(-1), reattachment);

    await drive(app, second.turnId);
    const items = ordinary.at(-1).wire.input;
    const compaction = items.findIndex((item) => item.type === 'compaction');
    assert.ok(compaction >= 0);
    const next = items[compaction + 1];
    assert.equal(next.role, 'user');
    assert.ok(JSON.stringify(next.content).includes(SKILL_REATTACHMENT_HEADER.slice(1, -1)));
    assert.ok(next.content.some((block) => block.text === reattachment.parts[1].text));
  });
});

test('重新附上的规划：最近优先、按名去重、跳过尾巴里的载入、每个技能 5K 以内、放不下的只列名字', () => {
  const pair = (id, name, body) => ({
    segmentKind: 'tool_pair', contentType: 'application/vnd.limcode.context-tool-pair+json',
    content: JSON.stringify({
      toolCall: { id, toolName: 'skills' },
      toolModelResult: { result: JSON.stringify({ toolCallId: id, status: 'succeeded', detail: { ok: true, output: {
        name, source: '.claude', baseDirectory: `/skills/${name}`, entryPath: `/skills/${name}/SKILL.md`, body, bodyStartLine: 4
      } } }) }
    })
  });
  const short = (label) => `# ${label}\n\n1. do ${label}`;
  const compressed = [
    pair('a-old', 'alpha', short('alpha old')),
    pair('b', 'beta', short('beta')),
    pair('c', 'gamma', BODY),
    pair('a-new', 'alpha', short('alpha new'))
  ];
  const plan = planSkillReattachment({ compressed, retained: [pair('b2', 'beta', short('beta'))], budgetTokens: 25_000 });
  assert.deepEqual(plan.skills, ['alpha', 'gamma']);
  assert.deepEqual(plan.omitted, []);
  assert.match(plan.content.parts[1].text, /alpha new/);
  assert.equal(plan.content.parts[1].text.includes('alpha old'), false);
  assert.ok(estimateTextTokens(plan.content.parts[2].text) <= SKILL_REATTACHMENT_PER_SKILL_TOKENS);

  const tight = planSkillReattachment({ compressed, retained: [], budgetTokens: 5_300 });
  assert.deepEqual(tight.skills, ['alpha', 'gamma']);
  assert.deepEqual(tight.omitted, ['beta']);
  assert.match(tight.content.parts[0].text, /not re-attached for lack of room[^\n]*: beta$/m);

  // Carried forward from an earlier compression, omitted names included, behind newer loads.
  const earlier = {
    segmentKind: 'compression', contentType: 'application/vnd.limcode.compression-contents+json',
    content: JSON.stringify({ kind: 'compression_contents', version: 1, contents: [
      { role: 'user', parts: [{ text: 'summary' }] }, tight.content
    ] })
  };
  const chained = planSkillReattachment({ compressed: [earlier, pair('d', 'delta', short('delta'))], retained: [], budgetTokens: 25_000 });
  assert.deepEqual(chained.skills, ['delta', 'alpha', 'gamma']);
  assert.deepEqual(chained.omitted, ['beta']);
  assert.equal(chained.content.parts[2].text, tight.content.parts[1].text);
  assert.equal(planSkillReattachment({ compressed: [pair('x', 'x', 'x')], retained: [pair('y', 'x', 'x')], budgetTokens: 25_000 }), undefined);
});

test('同名不同来源的技能按名字加来源区分，各自附上', () => {
  const pair = (id, source) => ({
    segmentKind: 'tool_pair', contentType: 'application/vnd.limcode.context-tool-pair+json',
    content: JSON.stringify({
      toolCall: { id, toolName: 'skills' },
      toolModelResult: { result: JSON.stringify({ toolCallId: id, status: 'succeeded', detail: { ok: true, output: {
        name: 'pdf', source, baseDirectory: `/skills/${source}/pdf`, entryPath: `/skills/${source}/pdf/SKILL.md`, body: `# pdf from ${source}`, bodyStartLine: 4
      } } }) }
    })
  });
  const both = planSkillReattachment({ compressed: [pair('u', 'user')], retained: [pair('c', '.claude')], budgetTokens: 25_000 });
  assert.deepEqual(both.skills, ['pdf'], 'the user pdf is re-attached although a .claude pdf is still in the tail');
  assert.match(both.content.parts[1].text, /# pdf from user/);
});

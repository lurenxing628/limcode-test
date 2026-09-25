/**
 * 模型看到的技能与 read 结果：
 * - 已载入的技能有自己的 25K 额度，同批其他工具结果挤不掉它；仍超出时按行保留开头，并在正文里说明
 *   截在哪里、从 SKILL.md 哪一行（startLine）继续读，同时给出结构化 rereadHint。
 * - 技能结果按渲染后的纯文本交给模型：Claude / Chat Completions / Responses 线上是原文（真换行，不再是
 *   `\n`、`\"` 转义的 JSON），Gemini 是官方约定的 `{ output }` / `{ error }` 对象。
 * - read 结果放不下时按行截断，endLine 改成实际显示的最后一行，"从 endLine + 1 续读"的约定仍然成立。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = (file) => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { renderLoadedSkill } = load('backend/world/modules/skill/skillLookup.js');
const { dryRunLlmProvider, dryRunCompactLlmProvider } = load('backend/capabilities/llmProvider.js');
const { readFileTool } = load('backend/world/modules/tools/definitions/readFile/index.js');
const { sliceTextFile } = load('backend/capabilities/textFileSlice.js');

const TOOL_PAIR = 'application/vnd.limcode.context-tool-pair+json';
const MESSAGE = 'application/vnd.limcode.message+json';

function skillOutput(body, name = 'demo') {
  return {
    name, source: '.claude', baseDirectory: `/skills/${name}`, entryPath: `/skills/${name}/SKILL.md`, body, bodyStartLine: 5
  };
}
/** The committed `skills` result exactly as the tool dispatcher settles it (status + detail {ok, output}). */
const skillResult = (output) => ({ status: 'succeeded', detail: { ok: true, output } });
/** A body of numbered steps with quotes and tabs: the characters JSON escapes. */
function skillBody(lines) {
  return Array.from({ length: lines }, (_, index) =>
    `${index + 1}. Run "step ${index + 1}"\tand check its "output" before moving on.`).join('\n');
}
const textOf = (response) => response.output ?? response.error;

test('技能结果有独立的 25K 额度：约 20KB 的 SKILL.md 原样完整，同批大结果不挤占它', () => {
  const output = skillOutput(skillBody(300));
  assert.ok(kernel.estimateJsonTokens(skillResult(output)) > kernel.TOOL_RESULT_MAX_TOKENS,
    'fixture must be a skill the shared 4K cap used to cut in the middle');
  const batch = kernel.projectToolResultBatch([
    { toolName: 'shell', callId: 'big', response: { status: 'succeeded', detail: { text: 'x'.repeat(400_000) } } },
    { toolName: 'skills', callId: 'skill', response: skillResult(output) },
    { toolName: 'search', callId: 'other', response: { status: 'succeeded', detail: { text: 'y'.repeat(400_000) } } }
  ]);
  const skill = batch.items[1];
  assert.equal(skill.truncated, false);
  assert.deepEqual(skill.response, { output: renderLoadedSkill(output, output.body) });
  assert.equal(skill.allocatedTokens, skill.originalTokens, 'a skill that fits keeps its whole text');
  // The shared 16K batch still bounds the other results, and only them.
  const others = batch.items[0].projectedTokens + batch.items[2].projectedTokens;
  assert.ok(others <= kernel.TOOL_RESULT_BATCH_MAX_TOKENS, `shared results ${others}`);
  assert.ok(batch.items[0].projectedTokens > 3_000, 'a skill in the batch does not shrink the other results');
});

test('超出 25K 的技能按行保留开头，正文写明截断位置与续读方式，并给出结构化 rereadHint', () => {
  const output = skillOutput(skillBody(3_000));
  const [item] = kernel.projectToolResultBatch([{ toolName: 'skills', callId: 'huge', response: skillResult(output) }]).items;
  assert.equal(item.truncated, true);
  assert.ok(item.projectedTokens <= kernel.SKILL_TOOL_RESULT_MAX_TOKENS, `projected ${item.projectedTokens}`);
  const text = item.response.output;
  const bodyLines = output.body.split('\n');
  const shown = /Shown above: lines 1-(\d+) of the skill body \((\d+) lines\)/.exec(text);
  assert.ok(shown, text.slice(-800));
  const lastShown = Number(shown[1]);
  assert.equal(Number(shown[2]), bodyLines.length);
  assert.ok(lastShown > 100 && lastShown < bodyLines.length);
  // Head kept up to a whole line; nothing from the middle or the tail leaks in.
  assert.ok(text.includes(`\n${bodyLines[lastShown - 1]}\n`), 'the last shown line is complete');
  assert.equal(text.includes(bodyLines[lastShown + 5]), false);
  assert.equal(text.includes(bodyLines.at(-1)), false);
  assert.match(text, new RegExp(`> ${escapeRegExp(bodyLines[lastShown])}`), 'the first omitted line is quoted');
  assert.match(text, /read the rest of SKILL\.md with the read tool: path "\/skills\/demo\/SKILL\.md", startLine \d+/);
  // The body starts on SKILL.md line 5 (below its frontmatter), so body line lastShown + 1 is file line 5 + lastShown.
  const hint = { kind: 'file', path: output.entryPath, startLine: output.bodyStartLine + lastShown };
  assert.ok(text.includes(`rereadHint: ${JSON.stringify(hint)}`));
  assert.deepEqual(item.reread, hint);
  assert.ok(text.startsWith(`<skill name="demo" source=".claude">\nBase directory for this skill: /skills/demo\n`));
  assert.ok(text.endsWith('\n</skill>'));
});

test('存储窗口投影：技能 tool_pair 投影为纯文本，失败说明为 { error }，与其他结果同批互不影响', () => {
  const output = skillOutput(skillBody(300));
  const pair = (id, toolName, result) => ({
    segmentId: `pair-${id}`, segmentKind: 'tool_pair', messageRole: null, contentType: TOOL_PAIR,
    content: JSON.stringify({
      kind: 'tool_pair',
      toolCall: { id: `tool-${id}`, providerCallId: id, toolName, arguments: '{}' },
      toolModelResult: { id: `result-${id}`, result: JSON.stringify({ toolCallId: `tool-${id}`, ...result }) }
    })
  });
  const projected = kernel.projectStoredModelFacingWindow([
    { segmentId: 'm', segmentKind: 'message', messageRole: 'model', contentType: MESSAGE, content: JSON.stringify({
      role: 'model', parts: ['ok', 'missing', 'read'].map((id) => ({ id, functionCall: { name: id === 'read' ? 'read' : 'skills', args: {} } }))
    }) },
    pair('ok', 'skills', skillResult(output)),
    pair('missing', 'skills', { status: 'failed', detail: { ok: false, output: '未找到技能 "nope"。可用的技能：demo。' } }),
    pair('read', 'read', { status: 'succeeded', detail: { path: '/a', startLine: 1, endLine: 1, totalLines: 1, content: '1 a' } })
  ]);
  const responses = projected.contents.slice(1).map((content) => content.parts[0].functionResponse.response);
  assert.deepEqual(responses[0], { output: renderLoadedSkill(output, output.body) });
  assert.deepEqual(responses[1], { error: '未找到技能 "nope"。可用的技能：demo。' });
  assert.deepEqual(responses[2], { status: 'succeeded', detail: { path: '/a', startLine: 1, endLine: 1, totalLines: 1, content: '1 a' } });
});

// ───────────────────────────── wire ─────────────────────────────

const RENDERED = renderLoadedSkill(skillOutput('# Demo\n\n1. Say "hi"\tthen stop.'), '# Demo\n\n1. Say "hi"\tthen stop.');
const FAILURE = '未找到技能 "nope"。';
const WIRE_CONTENTS = [
  { role: 'user', parts: [{ text: 'use the demo skill' }] },
  { role: 'model', parts: [
    { id: 'call_skill', functionCall: { name: 'skills', args: { name: 'demo' } } },
    { id: 'call_missing', functionCall: { name: 'skills', args: { name: 'nope' } } },
    { id: 'call_read', functionCall: { name: 'read', args: { path: 'a.txt' } } }
  ] },
  { role: 'user', parts: [
    { id: 'call_skill', functionResponse: { name: 'skills', response: { output: RENDERED } } },
    { id: 'call_missing', functionResponse: { name: 'skills', response: { error: FAILURE } } },
    { id: 'call_read', functionResponse: { name: 'read', response: { status: 'succeeded', detail: { output: 'x' } } } }
  ] }
];

function settings(provider, model, baseUrl = 'https://example.invalid/v1') {
  return {
    id: `${provider}-channel`, name: provider, provider, baseUrl, model, models: [{ id: model, name: model }], apiKey: '',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true, retryOnError: false, retryMaxAttempts: 0,
    retryDelaySeconds: 0, enableMultimodalTools: true, contextWindowTokens: 200000, modelConfigs: [], createdAt: 1, updatedAt: 1
  };
}
const dryRun = (providerSettings) => dryRunLlmProvider(
  { id: 'wire', invocationId: 'wire', conversationId: 'wire', contents: WIRE_CONTENTS, tools: [] },
  { settings: async () => providerSettings }
);

test('技能结果在 Claude、Chat Completions、Responses 线上是原文，Gemini 是 { output } / { error } 对象；其他结果不变', async () => {
  const claude = (await dryRun(settings('claude', 'claude-opus-5-5'))).body;
  const results = claude.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_result');
  assert.equal(results[0].content, RENDERED, 'real newlines and quotes, no JSON escaping');
  assert.equal(results[0].is_error, undefined);
  assert.equal(results[1].content, FAILURE);
  assert.equal(results[1].is_error, true);
  assert.equal(results[2].content, JSON.stringify({ status: 'succeeded', detail: { output: 'x' } }));

  const chat = (await dryRun(settings('openai-compatible', 'gpt-5.5'))).body;
  assert.deepEqual(chat.messages.filter((message) => message.role === 'tool').map((message) => message.content), [
    RENDERED, FAILURE, JSON.stringify({ status: 'succeeded', detail: { output: 'x' } })
  ]);

  const responses = (await dryRun(settings('openai-responses', 'gpt-5.5'))).body;
  assert.deepEqual(responses.input.filter((item) => item.type === 'function_call_output').map((item) => item.output), [
    RENDERED, FAILURE, JSON.stringify({ status: 'succeeded', detail: { output: 'x' } })
  ]);

  const gemini = (await dryRun(settings('gemini', 'gemini-3.5-flash', 'https://generativelanguage.googleapis.com/v1beta'))).body;
  const geminiResponses = gemini.contents.flatMap((content) => content.parts).filter((part) => part.functionResponse)
    .map((part) => part.functionResponse.response);
  assert.deepEqual(geminiResponses, [{ output: RENDERED }, { error: FAILURE }, { status: 'succeeded', detail: { output: 'x' } }]);
});

test('Responses 原生压缩请求里的技能结果同样是原文', async () => {
  const request = {
    id: 'compact-wire', blockId: 'compact-block', conversationId: 'compact-wire', methodKind: 'provider_native',
    methodConfigSnapshot: { id: 'native', name: 'Native', kind: 'provider_native', trigger: { mode: 'manual' }, createdAt: 1, updatedAt: 1 },
    settingsSnapshot: { providerConfigId: 'openai-responses-channel', provider: 'openai-responses', modelId: 'gpt-5.5' },
    tools: [], contents: [...WIRE_CONTENTS, { role: 'model', parts: [{ text: 'Done.' }] }]
  };
  const dry = await dryRunCompactLlmProvider(request, {
    settings: async () => settings('openai-responses', 'gpt-5.5', 'https://api.openai.com/v1'),
    compressionSettings: async () => undefined
  });
  const body = JSON.parse(dry.calls[0].bodyText);
  assert.match(dry.calls[0].url, /\/responses\/compact$/);
  assert.deepEqual(body.input.filter((item) => item.type === 'function_call_output').map((item) => item.output).slice(0, 2), [RENDERED, FAILURE]);
});

// ───────────────────────────── read ─────────────────────────────

const numbered = (from, to, text = (line) => `const value${line} = compute(${line}); // explanation`) =>
  Array.from({ length: to - from + 1 }, (_, index) => `${from + index} ${text(from + index)}`).join('\n');

test('read 结果超出额度时按行截断：endLine 是实际显示的最后一行，并给出续读位置', () => {
  const detail = { path: '/work/a.ts', startLine: 1, endLine: 600, totalLines: 900, content: numbered(1, 600) };
  const [item] = kernel.projectToolResultBatch([{ toolName: 'read', callId: 'r', response: { status: 'succeeded', detail } }]).items;
  assert.equal(item.truncated, true);
  assert.ok(item.projectedTokens <= kernel.TOOL_RESULT_MAX_TOKENS);
  const shown = item.response.detail;
  assert.equal(item.response.status, 'succeeded');
  assert.equal(shown.startLine, 1);
  assert.equal(shown.totalLines, 900);
  assert.ok(shown.endLine > 50 && shown.endLine < 600, `endLine ${shown.endLine}`);
  const lines = shown.content.split('\n');
  assert.equal(lines.length, shown.endLine - shown.startLine + 1, 'content holds exactly startLine..endLine');
  assert.equal(lines.at(-1), `${shown.endLine} const value${shown.endLine} = compute(${shown.endLine}); // explanation`);
  assert.equal(shown.truncated, true);
  assert.match(shown.note, new RegExp(`Continue with read startLine ${shown.endLine + 1}\\.`));
  assert.match(shown.note, /the file continues to line 900/);
  assert.deepEqual(shown.rereadHint, { kind: 'file', path: '/work/a.ts', startLine: shown.endLine + 1 });
  assert.deepEqual(item.reread, shown.rereadHint);

  // A read that fits is untouched.
  const small = { path: '/work/b.ts', startLine: 3, endLine: 5, totalLines: 5, content: numbered(3, 5) };
  const [exact] = kernel.projectToolResultBatch([{ toolName: 'read', response: { status: 'succeeded', detail: small } }]).items;
  assert.equal(exact.truncated, false);
  assert.deepEqual(exact.response.detail, small);
});

test('批量 read 按文件顺序填满额度，后面放不下的文件同样报出真实 endLine 与续读位置', () => {
  const files = ['/work/a.ts', '/work/b.ts', '/work/c.ts'].map((file) => ({
    path: file, startLine: 1, endLine: 300, totalLines: 300, content: numbered(1, 300)
  }));
  const [item] = kernel.projectToolResultBatch([{
    toolName: 'read', response: { status: 'succeeded', detail: { files } }
  }]).items;
  const shown = item.response.detail.files;
  assert.equal(shown.length, 3);
  assert.equal(shown[0].path, '/work/a.ts');
  assert.ok(shown.every((file, index) => file.path === files[index].path && file.totalLines === 300));
  for (const file of shown) {
    const lines = file.content ? file.content.split('\n') : [];
    assert.equal(lines.length, file.endLine - file.startLine + 1);
    if (file.truncated) assert.deepEqual(file.rereadHint, { kind: 'file', path: file.path, startLine: file.endLine + 1 });
  }
  assert.equal(shown.at(-1).truncated, true);
  assert.equal(shown.at(-1).endLine, 0);
  assert.match(shown.at(-1).note, /None of lines 1-300 of this read fit/);
});

test('read 工具自身的批量上限也按行截断并改写 endLine', async () => {
  // Two ~140K-character files: the first fits, the second overflows the batch budget.
  const content = Array.from({ length: 2_000 }, (_, index) => `row ${index + 1} ${'z'.repeat(60)}`).join('\n');
  const deps = {
    fs: {
      async readFile(file, startLine, endLine) {
        const slice = sliceTextFile(file, content, startLine, endLine);
        return { path: slice.path, startLine: slice.startLine, endLine: slice.endLine, totalLines: slice.totalLines, content: slice.content };
      }
    }
  };
  const result = await readFileTool.execute({ items: [{ path: 'a.txt' }, { path: 'b.txt' }] }, deps, { emit() {} });
  assert.equal(result.ok, true);
  const [first, second] = result.output.files;
  assert.equal(first.contentTruncated, undefined);
  assert.equal(second.contentTruncated, true);
  const lines = second.content.split('\n');
  assert.equal(lines.length, second.endLine - second.startLine + 1, 'endLine is the last line kept');
  assert.match(lines.at(-1), new RegExp(`^${second.endLine} row ${second.endLine} z+$`), 'no line is cut in the middle');
  assert.ok(second.endLine < second.totalLines);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('一批里的多个技能共享一份额度：小的完整保留，大的平分剩余', () => {
  const small = skillOutput(skillBody(20), 'small');
  const bigA = skillOutput(skillBody(3_000), 'big-a');
  const bigB = skillOutput(skillBody(3_000), 'big-b');
  const batch = kernel.projectToolResultBatch([small, bigA, bigB].map((output, index) =>
    ({ toolName: 'skills', callId: `s${index}`, response: skillResult(output) })));
  const [first, second, third] = batch.items;
  assert.equal(first.truncated, false, 'a small skill keeps its whole text');
  assert.equal(second.truncated, true);
  assert.equal(third.truncated, true);
  const total = batch.items.reduce((sum, item) => sum + item.projectedTokens, 0);
  assert.ok(total <= kernel.SKILL_TOOL_RESULT_MAX_TOKENS, `skills of one batch stay within one allowance (${total})`);
  assert.ok(Math.abs(second.allocatedTokens - third.allocatedTokens) <= 1, 'the large ones share evenly');
});

test('read 的第一行就放不下时显示这一行的开头，并指向下一行继续', () => {
  const line = 'x'.repeat(200_000);
  const response = { status: 'succeeded', detail: { path: '/a.min.js', startLine: 1, endLine: 2, totalLines: 2, content: `1 ${line}\n2 tail` } };
  const [item] = kernel.projectToolResultBatch([{ toolName: 'read', callId: 'long', response }]).items;
  assert.equal(item.truncated, true);
  const detail = item.response.detail;
  assert.ok(detail.content.startsWith('1 xxx') && detail.content.length > 1_000, 'the head of the long line is shown');
  assert.equal(detail.endLine, 1);
  assert.match(detail.note, /Line 1 is longer than fits in a tool result: only its first \d+ characters are shown/);
  assert.deepEqual(item.reread, { kind: 'file', path: '/a.min.js', startLine: 2 }, 'reading on starts after that line');
});

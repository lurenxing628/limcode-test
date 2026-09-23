import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const {
  toUnifiedRequest
} = require(path.join(root, 'dist/extension/backend/capabilities/unifiedMessageConversion.js'));
const unified = await import('unified-llm-provider');

/** 别家渠道产出的思考：签名前缀不是 claude，Claude 永远无法验证它。 */
function foreignThought(text) {
  return { text, thought: true, thoughtSignature: 'openai-responses:gAAAAABn-encrypted-blob' };
}

/** Claude 自己产出的思考：签名可以原样回放。 */
function claudeThought(text) {
  return { text, thought: true, thoughtSignature: 'claude:ErUBCkYIBxgCIkD-claude-sig' };
}

function startRequest(contents) {
  return { id: 'req-1', conversationId: 'conv-1', contents, tools: [] };
}

function claudeWireMessages(contents) {
  const request = toUnifiedRequest(startRequest(contents), undefined, 'claude');
  return new unified.ClaudeFormat('claude-opus-5').encodeRequest(request, false).messages;
}

function thinkingBlocks(messages) {
  return messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter((block) => block?.type === 'thinking')
    : []);
}

test('别家模型的思考不会被当成 Claude thinking 块发出去', () => {
  const messages = claudeWireMessages([
    { role: 'user', parts: [{ text: '帮我看看配置' }] },
    { role: 'model', parts: [foreignThought('gpt 的思考'), { text: '配置里 model 字段写错了。' }] }
  ]);

  // 回归的正是 messages.N.content.0.thinking.signature: Field required。
  assert.deepEqual(thinkingBlocks(messages), []);
  assert.deepEqual(messages.at(-1).content, [{ type: 'text', text: '配置里 model 字段写错了。' }]);
});

test('Claude 自己签过的思考原样回放', () => {
  const messages = claudeWireMessages([
    { role: 'user', parts: [{ text: '继续' }] },
    { role: 'model', parts: [claudeThought('Claude 的思考'), { text: '好的。' }] }
  ]);

  assert.deepEqual(thinkingBlocks(messages), [{
    type: 'thinking',
    thinking: 'Claude 的思考',
    signature: 'ErUBCkYIBxgCIkD-claude-sig'
  }]);
});

test('别家模型的思考被摘掉后工具调用配对不受影响', () => {
  const messages = claudeWireMessages([
    { role: 'user', parts: [{ text: '读文件' }] },
    {
      role: 'model',
      parts: [foreignThought('gpt 的思考'), { functionCall: { name: 'read_file', args: { p: 'x' } }, id: 'call_abc' }]
    },
    {
      role: 'user',
      parts: [{ functionResponse: { name: 'read_file', response: { ok: 1 } }, id: 'call_abc' }]
    }
  ]);

  assert.deepEqual(thinkingBlocks(messages), []);
  assert.equal(messages.at(-2).content.find((block) => block.type === 'tool_use')?.id, 'call_abc');
  assert.equal(messages.at(-1).content.find((block) => block.type === 'tool_result')?.tool_use_id, 'call_abc');
});

test('只剩别家思考的助手轮次整条消失而不是发出空消息', () => {
  const messages = claudeWireMessages([
    { role: 'user', parts: [{ text: 'a' }] },
    { role: 'model', parts: [foreignThought('被打断前的思考')] },
    { role: 'user', parts: [{ text: 'b' }] }
  ]);

  // Anthropic 会把连续的 user 轮次合并，所以丢掉整条助手消息是合法的；
  // 真正不能出现的是一条 content 为空的 assistant 消息。
  assert.equal(messages.every((message) => message.role === 'user'), true);
  assert.equal(messages.some((message) => Array.isArray(message.content) && message.content.length === 0), false);
});

test('其它渠道不受影响：思考照常按各自格式回放', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'a' }] },
    { role: 'model', parts: [claudeThought('Claude 的思考'), { text: '答案' }] }
  ];

  // 原生 Gemini 按同样的道理摘掉别家签名的思考（见 gemini-provider-adaptation.test.mjs 的 E3），只留回答。
  const geminiRequest = toUnifiedRequest(startRequest(contents), undefined, 'gemini');
  assert.deepEqual(geminiRequest.contents[1].parts, [{ text: '答案' }]);

  const openAIRequest = toUnifiedRequest(startRequest(contents), undefined, 'openai-compatible');
  assert.equal(openAIRequest.contents[1].parts[0].thought, true);
});

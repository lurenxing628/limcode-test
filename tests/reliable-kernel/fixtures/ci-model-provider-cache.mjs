import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { load, settings, user, model, call, result, startRequest, llm } from './ci-model-provider-support.mjs';

const { WebSocketServer } = createRequire(import.meta.url)('ws');
const session = load('backend/capabilities/openAIResponsesWebSocketSession.js');

export function registerProviderCacheTest(test) {
  test('显式缓存工具结果使用数组，断点变化保持增量而内容变化发全量', async () => {
    const frames = [];
    const server = http.createServer();
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, webSocket => {
        webSocket.on('message', raw => {
          const index = frames.length;
          frames.push(JSON.parse(String(raw)));
          const id = `cache-response-${index + 1}`;
          const item = index === 0
            ? { id: 'tool-item', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' }
            : { id: `message-${index}`, type: 'message', role: 'assistant',
              content: [{ type: 'output_text', text: 'done', annotations: [] }] };
          webSocket.send(JSON.stringify({ type: 'response.created', response: { id } }));
          if (index === 0) webSocket.send(JSON.stringify({ type: 'response.output_item.added',
            response_id: id, output_index: 0, item: { ...item, arguments: '' } }));
          webSocket.send(JSON.stringify({ type: 'response.output_item.done', response_id: id, output_index: 0, item }));
          webSocket.send(JSON.stringify({ type: 'response.completed', response: {
            id, status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
          } }));
        });
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = settings('openai-responses', { id: 'ci-cache-provider', model: 'gpt-5.6-sol',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, openaiResponsesTransport: 'websocket',
      promptCache: { enabled: true, mode: 'explicit', ttl: '30m' } });
    const tools = [{ name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
    const first = [user('task')];
    const second = [...first, model([call('call_1', 'read', { path: 'a' })]),
      { role: 'user', parts: [result('call_1', 'read', { text: 'A' })] }];
    const changed = [user('task changed'), ...second.slice(1), model([{ text: 'done' }]), user('next')];
    const decisions = [];
    const send = async (contents, id) => {
      const events = [];
      await llm.startLlmProvider(startRequest(contents, { id, invocationId: id,
        conversationId: 'cache-conversation', tools, systemInstruction: user('stable instructions') }),
      event => events.push(event), { settings: async () => config, onTransportTrace(trace) {
        if (trace.phase === 'continuation_decision') decisions.push(trace.mode);
      } });
      assert.equal(events.find(event => event.type === 'llm:error'), undefined);
    };
    session.resetOpenAIResponsesWebSocketSessions();
    try {
      await send(first, 'cache-first');
      await send(second, 'cache-tool-result');
      await send(changed, 'cache-changed');
      assert.deepEqual(decisions, ['full', 'incremental', 'full']);
      assert.equal(frames[1].previous_response_id, 'cache-response-1');
      assert.deepEqual(frames[1].input, [{ type: 'function_call_output', call_id: 'call_1',
        output: [{ type: 'input_text', text: '{"text":"A"}', prompt_cache_breakpoint: { mode: 'explicit' } }] }]);
      assert.equal(frames[2].previous_response_id, undefined);
      assert.ok(frames[2].input.length > 1);
      assert.deepEqual(frames[1].prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    } finally {
      session.resetOpenAIResponsesWebSocketSessions();
      for (const client of sockets.clients) client.terminate();
      await new Promise(resolve => sockets.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  });
}

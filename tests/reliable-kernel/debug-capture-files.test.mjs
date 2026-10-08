import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { DebugCaptureService } = require('../../dist/extension/backend/reliableKernel/debugCapture/service.js');
const { boundedJsonBytes } = require('../../dist/extension/shared/debugCaptureEncoding.js');
const context = { conversationId: 'conversation-a', modelRequestId: 'request-a', attemptSeq: 1, socketGeneration: 1 };
const source = { extensionVersion: 'test', sourceCommit: 'test', hostBootId: 'host-a', buildId: 'test-build' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-debug-files-'));
  let invalid = false;
  const authority = { validate: async () => { if (invalid) throw new Error('根目录已切换'); } };
  const binding = { paths: { dataRootPath: root } };
  const service = new DebugCaptureService(authority, binding, source);
  t.after(async () => { invalid = false; await service.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, service, authority, binding, invalidate: () => { invalid = true; }, start: async () => {
    await service.start({ commandId: 'start-a', settings: { scope: 'conversation', maxMiB: 8, maxMinutes: 5 }, conversationId: 'conversation-a' });
    return service.controller.current().runId;
  } };
}
test('关闭时不创建目录；编码预检保留中文、转义及半个字符', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10000; i++) assert.equal(f.service.record({ stage: 'test', context, payload: 'x' }), undefined);
  assert.deepEqual(await fs.readdir(f.root), []);
  for (const value of [null, '\ud800', '\udfff', '中文😀\n\r\t"\\', [undefined, NaN], { a: undefined, b: [true, false, 1.2] }]) assert.equal(boundedJsonBytes(value, 10000), Buffer.byteLength(JSON.stringify(value)));
  assert.throws(() => boundedJsonBytes('x'.repeat(1000000), 100), RangeError);
});
test('排队与可靠保存分开计数，原文先于索引，封存后校验全部通过', async t => {
  const f = await fixture(t); const id = await f.start();
  const ref = f.service.record({ stage: 'transport.receive', context, bytes: Buffer.from('中文😀'), metadata: { transport: 'http', streamId: 's', byteStart: 0, byteEnd: 10 } });
  f.service.record({ stage: 'http.decoded', context, payload: '\ud800', sources: [ref] });
  assert.equal(f.service.controller.current().lastAcceptedSeq, 2); assert.equal(f.service.controller.current().durableSeq, 0);
  await f.service.files.flush();
  assert.equal(f.service.controller.current().durableSeq, 2);
  await f.service.stop(id);
  const report = await f.service.analyze(id);
  assert.equal(report.events, 2); assert.deepEqual(report.integrity, []);
  const manifest = await f.service.files.readManifest(id);
  assert.equal(manifest.status, 'sealed'); assert.equal(manifest.batches, 1); assert.ok(manifest.acceptedBytes <= manifest.maxBytes);
  assert.deepEqual((await fs.readFile(path.join(f.service.files.runPath(id), 'payloads.bin'))).subarray(0, 10), Buffer.from('中文😀'));
});
test('过大的单条停止取证，不把大对象编码入队，也不抛进模型', async t => {
  const f = await fixture(t); const id = await f.start();
  assert.doesNotThrow(() => f.service.record({ stage: 'large', context, payload: 'x'.repeat(5 * 1048576) }));
  assert.equal(f.service.active(context), undefined); await f.service.stop(id);
  assert.equal(f.service.controller.current().stopReason, 'memory_limit');
  assert.equal(f.service.controller.current().lastAcceptedSeq, 0); assert.equal(f.service.controller.current().hasGaps, true);
});
test('根目录失效不写旧路径，不虚报可靠截止点', async t => {
  const f = await fixture(t); const id = await f.start();
  f.service.record({ stage: 'queued', context, payload: 'body' }); f.invalidate(); await f.service.files.flush();
  assert.equal(f.service.active(context), undefined); assert.equal(f.service.controller.current().durableSeq, 0);
  await f.service.stop(id).catch(() => {});
  const disk = JSON.parse(await fs.readFile(path.join(f.service.files.runPath(id), 'manifest.json'), 'utf8'));
  assert.equal(disk.durableSeq, 0);
});
test('截断和未发布尾部被识别，不把额外原文作为可靠证据', async t => {
  const f = await fixture(t); const id = await f.start();
  f.service.record({ stage: 'one', context, payload: 'abcdef' }); await f.service.stop(id);
  const file = path.join(f.service.files.runPath(id), 'payloads.bin'); await fs.appendFile(file, 'tail');
  let report = await f.service.analyze(id);
  assert.equal(report.events, 1); assert.ok(report.integrity.some(x => x.includes('截止点外')));
  await fs.truncate(file, 1); report = await f.service.analyze(id);
  assert.equal(report.events, 0); assert.ok(report.integrity.some(x => x.includes('原文位置')));
});
test('保存实际错配、同源重复追加和等长变更证据', async t => {
  const f = await fixture(t); const id = await f.start();
  const raw = f.service.record({ stage: 'transport.receive', context, bytes: Buffer.from(JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'foreign', delta: 'ab' })), metadata: { transport: 'websocket' } });
  f.service.record({ stage: 'ws.tool_baseline', context, payload: '', metadata: { callId: 'call-a', streamIndex: 'item-a' } });
  for (let i = 0; i < 2; i++) f.service.record({ stage: 'ws.tool_assembly', context, payload: 'cd', sources: [raw], metadata: { callId: 'call-a', streamIndex: 'item-a', rawItemId: 'foreign', operation: 'append', selectionReason: 'single_active_fallback', beforeChars: i * 2, afterChars: (i + 1) * 2 } });
  await f.service.stop(id); const report = await f.service.analyze(id);
  assert.ok(report.findings.some(x => x.message.includes('再次追加')));
  assert.ok(report.findings.some(x => x.message.includes('内容与对应入口')));
  assert.ok(report.findings.some(x => x.message.includes('不匹配'))); assert.equal(report.tools[0].characters, 4);
});
test('读取期间禁止删除，导出不覆盖，旧开启命令跨重启仍幂等', async t => {
  const f = await fixture(t); const id = await f.start();
  await f.service.start({ commandId: 'start-b', conversationId: 'conversation-a', settings: { scope: 'conversation', maxMiB: 32, maxMinutes: 30 } });
  await assert.rejects(f.service.analyze(id), /先停止/); await f.service.stop(id);
  await f.service.files.withRead(id, async () => { await assert.rejects(f.service.files.remove(id), /使用中/); });
  const target = path.join(f.root, 'exported'); await f.service.files.export(id, target);
  await assert.rejects(f.service.files.export(id, target), /EEXIST/);
  const next = new DebugCaptureService(f.authority, f.binding, source);
  await next.start({ commandId: 'start-b', conversationId: 'conversation-a', settings: { scope: 'conversation', maxMiB: 32, maxMinutes: 30 } });
  assert.equal(next.active(context), undefined); assert.equal((await next.state()).runs.length, 1);
  await next.close(); await f.service.files.remove(id); assert.equal((await f.service.state()).runs.length, 0);
});

test('真实普通连接保留跨块字节、两个工具与思考，不改变模型输出', async t => {
  const f = await fixture(t); const id = await f.start();
  const unified = await import('unified-llm-provider');
  const { createTerminalValidatedFetch } = require('../../dist/extension/backend/capabilities/terminalValidatedFetch.js');
  const { DebugHttpObservation } = require('../../dist/extension/backend/reliableKernel/debugCapture/observer.js');
  const wireEvents = [
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'echo', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item-a', delta: '{"text":"中文"}' },
    { type: 'response.function_call_arguments.done', item_id: 'item-a', arguments: '{"text":"中文"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'echo', arguments: '{"text":"中文"}' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'reasoning', delta: '思考内容' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-b', call_id: 'call-b', name: 'echo', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item-b', delta: '{"text":"乙"}' },
    { type: 'response.function_call_arguments.done', item_id: 'item-b', arguments: '{"text":"乙"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-b', call_id: 'call-b', name: 'echo', arguments: '{"text":"乙"}' } },
    { type: 'response.completed', response: { id: 'response-a', status: 'completed', output: [] } }
  ];
  const raw = Buffer.from(wireEvents.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  const run = async recorder => {
    const provider = unified.createLLMFromConfig({ provider: 'openai-responses', model: 'test', apiKey: 'offline', baseUrl: 'https://example.invalid/v1',
      fetch: createTerminalValidatedFetch(async () => new Response(new ReadableStream({ start(c) {
        for (let i = 0; i < raw.length; i += 17) c.enqueue(raw.subarray(i, i + 17)); c.close();
      } }), { headers: { 'content-type': 'text/event-stream' } }), 'openai-responses',
      { createObservation: recorder ? () => new DebugHttpObservation(recorder, context, unified.attachLlmResponseObserver) : undefined })
    }, unified.createBootstrapExtensionRegistry().llmProviders);
    const output = [];
    for await (const chunk of provider.chatStream({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, { inputFormat: 'unified', outputFormat: 'unified' })) output.push(chunk);
    return output;
  };
  assert.deepEqual(await run(f.service), await run(undefined));
  await f.service.stop(id);
  const report = await f.service.analyze(id);
  assert.deepEqual(report.integrity, []);
  assert.equal(report.tools.length, 2); assert.ok(report.tools.every(tool => tool.completed));
  assert.equal(report.findings.length, 0, JSON.stringify(report.findings));
});

test('二十万以上未闭合参数能从增量重建，不伪造完成', async t => {
  const f = await fixture(t); const id = await f.start();
  const unified = await import('unified-llm-provider');
  const { createTerminalValidatedFetch } = require('../../dist/extension/backend/capabilities/terminalValidatedFetch.js');
  const { DebugHttpObservation } = require('../../dist/extension/backend/reliableKernel/debugCapture/observer.js');
  let index = 0;
  const count = 420;
  const body = new ReadableStream({ pull(c) {
    if (index > count) { c.close(); return; }
    const event = index++ === 0
      ? { type: 'response.output_item.added', item: { type: 'function_call', id: 'large-item', call_id: 'large-call', name: 'echo', arguments: '{"text":"' } }
      : { type: 'response.function_call_arguments.delta', item_id: 'large-item', delta: 'x'.repeat(512) };
    c.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
  } }, { highWaterMark: 0 });
  const fetcher = createTerminalValidatedFetch(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), 'openai-responses', { createObservation: () => new DebugHttpObservation(f.service, context, unified.attachLlmResponseObserver) });
  const response = await fetcher('https://example.invalid/v1/responses');
  let chunks = 0;
  for await (const chunk of unified.processStreamResponse(response, new unified.OpenAIResponsesFormat('test'))) {
    assert.equal(chunk.functionCalls?.length ?? 0, 0);
    if (++chunks % 32 === 0) await f.service.files.flush();
  }
  await f.service.stop(id);
  const report = await f.service.analyze(id);
  assert.equal(report.tools[0].characters, 9 + count * 512);
  assert.equal(report.tools[0].completed, false);
  assert.equal(f.service.controller.current().hasGaps, false);
  assert.ok(f.service.controller.current().peakMemoryBytes <= 4 * 1048576);
});

test('文件索引写入失败、清单发布失败都保留旧截止点，不重试', async t => {
  for (const failure of ['index', 'manifest']) {
    const f = await fixture(t); const id = await f.start();
    f.service.record({ stage: 'accepted', context, payload: 'original' });
    if (failure === 'index') await f.service.files.indexFile.close();
    else await fs.mkdir(path.join(f.service.files.runPath(id), 'manifest.json.tmp'));
    await f.service.files.flush(); await f.service.stop(id).catch(() => {});
    assert.equal(f.service.controller.current().durableSeq, 0);
    assert.equal(f.service.controller.current().stopReason, 'write_failed');
    const stored = JSON.parse(await fs.readFile(path.join(f.service.files.runPath(id), 'manifest.json'), 'utf8'));
    assert.equal(stored.durableSeq, 0);
  }
});

test('按真实写入量到达单次容量限制，收尾仍保留完整前缀', async t => {
  for (const maxMiB of [8, 16, 32]) {
    const f = await fixture(t);
    await f.service.start({ commandId: 'budget-test', conversationId: context.conversationId, settings: { scope: 'conversation', maxMiB, maxMinutes: 5 } });
    const id = f.service.active();
    let count = 0;
    while (f.service.active(context)) {
      f.service.record({ stage: 'chunk', context, payload: 'x'.repeat(128 * 1024) });
      if (++count % 4 === 0) await f.service.files.flush();
      assert.ok(count < 300);
    }
    await f.service.stop(id);
    const run = f.service.controller.current();
    assert.equal(run.stopReason, 'size_limit'); assert.ok(run.acceptedBytes <= run.maxBytes);
    assert.ok((await f.service.state()).totalBytes <= run.maxBytes);
    const report = await f.service.analyze(id); assert.equal(report.events, run.durableSeq);
  }
});

test('在原文、索引和清单同步后强制退出，重启只承认已公布前缀', { timeout: 15000 }, async t => {
  for (const phase of ['payload', 'index', 'manifest']) {
    const f = await fixture(t);
    const code = `
      const {DebugCaptureService}=require(${JSON.stringify(path.resolve('dist/extension/backend/reliableKernel/debugCapture/service.js'))});
      (async()=>{
        const service=new DebugCaptureService({validate:async()=>{}},{paths:{dataRootPath:process.argv[1]}},${JSON.stringify(source)});
        await service.start({commandId:'crash',conversationId:'conversation-a',settings:{scope:'conversation',maxMiB:8,maxMinutes:5}});
        const runId=service.active();
        const pause=async()=>{process.send({runId});await new Promise(()=>{});};
        if(process.argv[2]==='manifest'){
          const publish=service.files.publish.bind(service.files);service.files.publish=async(...args)=>{await publish(...args);await pause();};
        }else{
          const file=process.argv[2]==='payload'?service.files.payloadFile:service.files.indexFile;
          const sync=file.sync.bind(file);file.sync=async()=>{await sync();await pause();};
        }
        service.record({stage:'crash-event',context:${JSON.stringify(context)},payload:'原始消息'});
        await service.files.flush();
      })().catch(error=>{console.error(error);process.exit(1)});
    `;
    const child = spawn(process.execPath, ['-e', code, f.root, phase], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('故障注入子进程提前结束'); })]);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    assert.equal(f.service.active(), undefined);
    const state = await f.service.state(); assert.equal(state.runs[0].stopReason, 'interrupted');
    const report = await f.service.analyze(ready.runId);
    assert.equal(report.events, phase === 'manifest' ? 1 : 0);
    assert.ok(report.integrity.some(message => message.includes('未正常封存')));
  }
});

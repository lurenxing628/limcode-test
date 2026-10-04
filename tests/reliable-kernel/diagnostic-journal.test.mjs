import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(root, 'dist/extension/backend/reliableKernel/index.js')).href);

test('ReliableDiagnosticJournal 只持久化脱敏 metadata 并保持文件/内存/返回值边界', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-diagnostic-journal-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const journal = new kernel.ReliableDiagnosticJournal(authority, binding);
  try {
    journal.observe({
      eventKind: 'provider.transient.first_event',
      scopeKind: 'model_request',
      scopeId: 'model-request-1',
      correlationId: '1',
      metadata: {
        modelRequestId: 'model-request-1',
        streamSeq: '1',
        kind: 'output_delta',
        prompt: '禁止持久化的 prompt',
        output: '禁止持久化的 output',
        headers: { authorization: 'secret' },
        status: 'x'.repeat(1_000)
      }
    });
    await journal.flush();
    const initial = await journal.inspect({ limit: 10 });
    assert.equal(initial.events.length, 1);
    assert.deepEqual(initial.events[0].metadata, {
      modelRequestId: 'model-request-1',
      streamSeq: '1',
      kind: 'output_delta',
      status: 'x'.repeat(192)
    });
    assert.doesNotMatch(JSON.stringify(initial), /禁止持久化|authorization|secret/);
    assert.equal(initial.spans[0].kind, 'provider-first-paint');
    assert.equal(initial.spans[0].correlationId, 'model-request-1');

    journal.observe({
      eventKind: 'provider.transport.phase',
      scopeKind: 'model_request',
      scopeId: 'model-request-frame',
      correlationId: '1:request_sent',
      metadata: {
        modelRequestId: 'model-request-frame',
        stage: 'request_sent',
        responseCreateFrameBytes: 37,
        responseCreateSeq: 2,
        requestBody: '禁止持久化的请求体'
      }
    });
    await journal.flush();
    const frameTrace = await journal.inspect({ scopeId: 'model-request-frame', limit: 10 });
    assert.equal(frameTrace.events.length, 1);
    assert.deepEqual(frameTrace.events[0].metadata, {
      modelRequestId: 'model-request-frame',
      stage: 'request_sent',
      responseCreateFrameBytes: 37,
      responseCreateSeq: 2
    });
    assert.doesNotMatch(JSON.stringify(frameTrace), /禁止持久化的请求体|requestBody/);

    journal.observe({
      eventKind: 'agent.lifecycle',
      scopeKind: 'turn',
      scopeId: 'turn-open-tasks',
      correlationId: 'model-request-open-tasks',
      metadata: {
        turnId: 'turn-open-tasks',
        modelRequestId: 'model-request-open-tasks',
        stage: 'open_tasks_at_final',
        openTaskCount: 3,
        taskCardSha256: 'a'.repeat(64),
        activeChildCount: 1,
        runningProcessCount: 2,
        taskTitle: '禁止持久化的任务正文'
      }
    });
    await journal.flush();
    const openTasks = await journal.inspect({ scopeId: 'turn-open-tasks', limit: 10 });
    assert.equal(openTasks.events.length, 1);
    assert.deepEqual(openTasks.events[0].metadata, {
      turnId: 'turn-open-tasks',
      modelRequestId: 'model-request-open-tasks',
      stage: 'open_tasks_at_final',
      openTaskCount: 3,
      taskCardSha256: 'a'.repeat(64),
      activeChildCount: 1,
      runningProcessCount: 2
    });
    assert.doesNotMatch(JSON.stringify(openTasks), /禁止持久化的任务正文|taskTitle/);

    for (let index = 0; index < 5_000; index += 1) {
      journal.observe({
        eventKind: 'feed.data.acked',
        scopeKind: 'feed_session',
        scopeId: 'session-1',
        correlationId: String(index + 1),
        metadata: {
          conversationId: 'conversation-1',
          sessionId: 'session-1',
          messageSeq: String(index + 1),
          elapsedMs: index % 100,
          status: 'y'.repeat(192)
        }
      });
      if (index % 100 === 99) await journal.flush();
    }
    const inspection = await journal.inspect({ scopeId: 'conversation-1', limit: 25 });
    assert.equal(inspection.events.length, 25);
    assert.equal(inspection.bounds.maxTotalBytes, 8 * 1_048_576);
    assert.equal(inspection.bounds.maxPendingEvents, 512);
    assert.equal(inspection.bounds.maxReturnedEvents, 200);
    assert.equal(inspection.bounds.maxReturnedSpans, 100);
    assert.ok(inspection.spans.length <= 100);
    assert.ok(inspection.spans.every((span) => span.kind === 'feed-roundtrip'));
    assert.ok(inspection.state.rotations > 0);
    assert.equal(inspection.state.pendingEvents, 0);

    const diagnosticRoot = path.join(binding.paths.dataRootPath, 'diagnostics');
    const files = (await fs.readdir(diagnosticRoot)).filter((name) => name.endsWith('.jsonl'));
    assert.ok(files.length <= inspection.bounds.maxFiles);
    for (const file of files) {
      assert.ok((await fs.stat(path.join(diagnosticRoot, file))).size <= inspection.bounds.maxFileBytes);
    }
  } finally {
    await journal.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

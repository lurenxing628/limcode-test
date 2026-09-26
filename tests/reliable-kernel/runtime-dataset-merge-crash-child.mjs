// An old window on a merge source that crashes mid-Turn (runtime-dataset-merge-e2e.test.mjs).
//   <scopeRoot> <settingsRoot> <readyFile>
// Turn 1 completes; Turn 2 streams partial output and hangs; a second user message is queued
// behind it. Then readyFile is written and the parent SIGKILLs this process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openFullRuntime, createRootConversation, modelAnswer } from './runtime-dataset-merge-full-runtime.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
const [scopeRoot, settingsRoot, readyFile] = process.argv.slice(2);

let streamingResolve;
const streaming = new Promise((resolve) => { streamingResolve = resolve; });
let call = 0;
const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
const runtime = await openFullRuntime({ authority, settingsRoot, hostLabel: 'old-window', async send(_request, controls) {
  call += 1;
  if (call === 1) {
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: modelAnswer('第一轮已完成') });
    return;
  }
  await controls.onEvent({ kind: 'output_delta', streamSeq: '1', content: { type: 'text_delta', text: '第二轮只输出了一半' } });
  streamingResolve();
  await new Promise(() => {});
} });
await runtime.startupRecovery();
await createRootConversation(runtime.app, runtime.agentIds.parent, 'crash_conversation');
const first = await runtime.runner.input({ conversationId: 'crash_conversation', commandId: 'first', text: '第一条' });
for (;;) {
  const [termination] = (await runtime.app.database.snapshotAll(repo('TurnTermination').list({ where: { turn_id: first.turnId }, orderBy: { column: 'id', direction: 'asc' }, limit: 1 }))).snapshot;
  if (termination) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
await runtime.runner.input({ conversationId: 'crash_conversation', commandId: 'second', text: '第二条' });
await streaming;
// A user message sent while Turn 2 is still streaming waits in the queue.
const queued = await runtime.runner.input({ conversationId: 'crash_conversation', commandId: 'third', text: '排队的第三条' });
await fs.writeFile(readyFile, JSON.stringify({ firstTurnId: first.turnId, queued }));
await new Promise(() => {});

function repo(name) { return require(path.join(compiled, 'backend/reliableKernel/index.js')).DOMAIN_REPOSITORIES.domain(name); }

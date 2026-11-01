import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { authorityAt, compiled, installVscode } from './configuration-smoke-fixture.mjs';
import { openDeliveryFixture } from './collaboration-delivery-fixture.mjs';

const host = installVscode();
after(() => host.dispose());
const { completedMainTasks } = compiled('backend/application/reliableKernel/taskCompletionSound.js');
const { normalizeTaskCompletionSoundSettings } = compiled('shared/taskCompletionSound.js');

test('提示音默认关闭，导入音频与音量沿现有设置修订保存并重读', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-completion-sound-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { authority } = authorityAt(root);
  const initial = await authority.loadGlobalSettings('taskCompletionSound');
  assert.deepEqual(initial.settings, { enabled: false, volume: 50, audioDataUrl: '', audioName: '' });
  await assert.rejects(fs.stat(path.join(root, 'settings')), { code: 'ENOENT' });
  const audio = await fs.readFile('webview/src/assets/task-complete.wav');
  const settings = { enabled: true, volume: 65, audioName: 'voice.wav', audioDataUrl: 'data:audio/wav;base64,' + audio.toString('base64') };
  await authority.saveGlobalSettings('taskCompletionSound', settings, initial.revision);
  const saved = await authorityAt(root).authority.loadGlobalSettings('taskCompletionSound');
  assert.deepEqual(saved.settings, settings);
  assert.match(saved.filePath, /task-completion-sound\.json$/);
  await assert.rejects(authority.saveGlobalSettings('taskCompletionSound', { ...settings, volume: 10 }, initial.revision),
    error => error.settingsRevisionConflict === true);
  assert.equal(normalizeTaskCompletionSoundSettings({ ...settings, volume: 500 }).volume, 100);
  assert.throws(() => normalizeTaskCompletionSoundSettings({ ...settings, audioDataUrl: 'data:text/html;base64,AA==' }), /MP3/);
  assert.throws(() => normalizeTaskCompletionSoundSettings({ ...settings, audioDataUrl: 'data:audio/wav;base64,' + 'A'.repeat(3 * 1024 * 1024) }), /2 MB/);
});

const terminalCommit = (reason = 'model_completed_without_tool_calls', status = 'completed') => ({
  commitSeq: '12', allocatedSequences: [], changes: [
    { domain: 'Turn', kind: 'upsert', id: 'turn', record: { id: 'turn', conversation_id: 'conversation', status: 'terminated' } },
    { domain: 'TurnTermination', kind: 'upsert', id: 'termination', record: { turn_id: 'turn', terminal_status: status, reason } }
  ]
});

test('只通知本宿主最终成功的主任务，子 Agent、维护、工具边界、停止和历史同步不通知', async () => {
  const reads = [];
  let child = false;
  const database = { async snapshot(queries) {
    reads.push(queries);
    return { snapshot: [child ? [{ id: 'child-turn' }] : []] };
  } };
  for (const reason of ['model_completed_without_tool_calls', 'model_completed_with_open_tasks', 'native_logical_request_completed']) {
    assert.deepEqual(await completedMainTasks(database, terminalCommit(reason)), [{ turnId: 'turn', conversationId: 'conversation' }]);
  }
  child = true;
  assert.deepEqual(await completedMainTasks(database, terminalCommit()), []);
  const before = reads.length;
  for (const commit of [
    { ...terminalCommit(), observedExternal: true },
    terminalCommit('queued_guidance_after_tool_batch'),
    terminalCommit('queued_runtime_delivery_after_response_boundary'),
    terminalCommit('compression_completed'),
    terminalCommit('turn_failed', 'failed'),
    terminalCommit('user_stop', 'interrupted'),
    { commitSeq: '13', allocatedSequences: [], changes: [{ domain: 'ToolCall', kind: 'upsert', id: 'tool', record: { status: 'terminal' } }] }
  ]) assert.deepEqual(await completedMainTasks(database, commit), []);
  assert.equal(reads.length, before, '非最终完成事件不读数据库，也不扫描历史');
  assert.equal(reads.length, 4, '每个候选只查一次确切 Turn 的子 Agent 关系');
  assert.deepEqual(reads[0][0].where, { turn_id: 'turn' });
  assert.equal(reads[0][0].limit, 1);
});

test('真实终态事务只通知一次，重放完成命令不重复通知', async t => {
  const f = await openDeliveryFixture();
  t.after(() => f.close());
  const parent = await f.parentTurn('sound-once');
  const pending = [];
  const unsubscribe = f.app.database.onCommit(commit => {
    if (commit.changes.some(change => change.domain === 'TurnTermination')) pending.push(completedMainTasks(f.app.database, commit));
  });
  t.after(unsubscribe);
  const command = { source: { kind: 'internal', key: 'sound-complete' }, turnId: parent.turnId,
    terminalStatus: 'completed', reason: 'model_completed_without_tool_calls' };
  await f.app.turns.terminal(command);
  await f.app.turns.terminal(command);
  assert.deepEqual((await Promise.all(pending)).flat(), [parent]);
});

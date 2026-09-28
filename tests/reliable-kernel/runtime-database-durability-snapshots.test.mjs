// The database worker's durability barrier and single-read snapshots (blind review of the worker):
// RuntimeDatabase.durabilityCheckpoint returns only once every commit made before it is in the
// database file itself (commits are synced only at a checkpoint, synchronous = NORMAL), and fails,
// never passes, while a reader of another process still needs an older state; countDomainRows and
// relocatedWorkInventory each read one snapshot while another process keeps committing.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createConfigurationRoot, Database, generateSyntheticSource, kernel, kernelFile, NOW, removeConfigurationRoot, repo
} from './fixtures/runtime-merge-fixture.mjs';

const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
const TEST_FILE = fileURLToPath(import.meta.url);
/** Collaboration budgets per churn commit (a table counted long after the first two): with its Conversation and Turn, 10 rows in three tables. */
const CHURN_BUDGETS = 8;

const conversation = (id) => repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW });

if (process.env.LIMCODE_DATABASE_SNAPSHOT_CHILD === 'churn') {
  // Another process committing as fast as it can until its stdin closes: each commit one active
  // Conversation with its active Turn and CHURN_BUDGETS collaboration budgets.
  const { scopeRoot } = JSON.parse(process.env.LIMCODE_DATABASE_SNAPSHOT_INPUT);
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `churn-${randomUUID()}` });
  let stop = false;
  process.stdin.on('end', () => { stop = true; });
  process.stdin.resume();
  let commits = 0;
  while (!stop) {
    await database.transaction(churnSteps(`churn_${String(commits).padStart(6, '0')}`));
    commits += 1;
    if (commits === 1) process.stdout.write('ready\n');
  }
  await database.close();
  process.stdout.write(`commits ${commits}\n`);
  process.exit(0);
}

async function fixtureFor(t) {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  return fixture;
}

function openWindow(fixture) {
  return kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
}


function churnSteps(id) {
  return [
    conversation(id),
    repo('Turn').insert({ id: `${id}_turn`, conversation_id: id, status: 'active', created_at: NOW, updated_at: NOW }),
    ...Array.from({ length: CHURN_BUDGETS }, (_, index) => repo('CollaborationBudget').insert({
      id: `${id}_budget_${index}`, origin_kind: 'turn', origin_key: `${id}_origin_${index}`, authority_turn_id: `${id}_turn`, created_at: NOW
    }))
  ];
}

test('落盘屏障 durabilityCheckpoint：返回之后单看库文件（不带预写日志）就有它之前的全部提交；另一个进程还停在旧的读快照时报错、从不当作已落盘，它读完之后再做就成功；维护事务打开期间拒绝', async (t) => {
  const fixture = await fixtureFor(t);
  const databasePath = fixture.current.binding.paths.databasePath;
  const database = await openWindow(fixture);
  try {
    await database.transaction([conversation('conversation_before_barrier')]);
    assert.equal(await databaseFileHas(databasePath, 'conversation_before_barrier'), false, '前提：提交之后（synchronous = NORMAL）还只在预写日志里');
    await database.durabilityCheckpoint();
    assert.equal(await databaseFileHas(databasePath, 'conversation_before_barrier'), true, '屏障之后库文件本身就有这次提交');

    const reader = await holdReadSnapshot(databasePath);
    try {
      await database.transaction([conversation('conversation_while_read')]);
      await assert.rejects(database.durabilityCheckpoint(), /没能全部写回磁盘.*另一个窗口还在读旧的状态/);
      assert.equal(await databaseFileHas(databasePath, 'conversation_while_read'), false, '确实没有写回');
    } finally { await reader.release(); }
    await database.durabilityCheckpoint();
    assert.equal(await databaseFileHas(databasePath, 'conversation_while_read'), true);
  } finally { await database.close(); }

  await kernelFile('runtimeHostControl.js').withRuntimeMaintenance(fixture.current.binding.paths, async () => {
    const maintenance = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `historical-merge-${randomUUID()}`, maintenance: true });
    try {
      await maintenance.maintenanceBegin();
      await assert.rejects(maintenance.durabilityCheckpoint(), /maintenance transaction is open on this Runtime database; durabilityCheckpoint is refused/);
      await maintenance.maintenanceRollback();
      await maintenance.durabilityCheckpoint();
    } finally { await maintenance.close(); }
  });
});

test('countDomainRows 在另一个进程不停提交时仍是一个读快照：每次的总数都落在某次提交之后（整 10 行），没有数到半个提交', { timeout: 120_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  await generateSyntheticSource(fixture.current, { rows: 40_000, prefix: 'count_seed' });
  const database = await openWindow(fixture);
  try {
    const base = await database.countDomainRows();
    const totals = new Set();
    const churn = await startChurn(fixture);
    try {
      for (const deadline = Date.now() + 6_000; Date.now() < deadline;) totals.add(await database.countDomainRows());
    } finally { await churn.stop(); }
    const torn = [...totals].filter((total) => (total - base) % (CHURN_BUDGETS + 2) !== 0);
    assert.deepEqual(torn, [], `数到了半个提交（基数 ${base}）`);
    assert.ok(totals.size >= 20, `计数期间确有提交落进来：${totals.size} 个不同的总数，另一进程提交 ${churn.commits} 次`);
    assert.equal(await database.countDomainRows(), base + churn.commits * (CHURN_BUDGETS + 2));
  } finally { await database.close(); }
});

test('relocatedWorkInventory 在另一个进程不停提交时仍是一个读快照：每个新对话都连同它的活动 Turn 一起列出，不会只看到对话、把 Turn 当成“其它未完成工作”', { timeout: 120_000 }, async (t) => {
  const fixture = await fixtureFor(t);
  await generateSyntheticSource(fixture.current, { rows: 40_000, prefix: 'inventory_seed' });
  const database = await openWindow(fixture);
  try {
    const torn = [];
    const listed = new Set();
    let inventories = 0;
    const churn = await startChurn(fixture);
    try {
      for (const deadline = Date.now() + 6_000; Date.now() < deadline; inventories += 1) {
        const { conversations } = await database.relocatedWorkInventory();
        const churned = conversations.filter((entry) => entry.conversationId.startsWith('churn_'));
        listed.add(churned.length);
        for (const entry of churned) {
          if (entry.otherRuntimeWork || JSON.stringify(entry.activeTurnIds) !== JSON.stringify([`${entry.conversationId}_turn`])) {
            torn.push({ conversationId: entry.conversationId, activeTurnIds: entry.activeTurnIds, otherRuntimeWork: entry.otherRuntimeWork });
          }
        }
      }
    } finally { await churn.stop(); }
    assert.deepEqual(torn.slice(0, 5), [], `盘点里有半个提交（共 ${torn.length} 处）`);
    assert.ok(listed.size >= 10, `盘点期间确有提交落进来：${inventories} 次盘点见到 ${listed.size} 种新对话数，另一进程提交 ${churn.commits} 次`);
    assert.equal((await database.relocatedWorkInventory()).conversations.filter((entry) => entry.conversationId.startsWith('churn_')).length, churn.commits);
  } finally { await database.close(); }
});

/** Whether the database file alone (no WAL) holds Conversation `id`: copied by another process (the POSIX lock rule). */
async function databaseFileHas(databasePath, id) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-database-file-'));
  try {
    const copy = path.join(directory, 'copy.sqlite');
    await run(['-e', 'require("node:fs").copyFileSync(process.argv[1], process.argv[2])', databasePath, copy]);
    const database = new Database(copy);
    try { return database.prepare('SELECT COUNT(*) FROM conversation WHERE id = ?').pluck().get(id) === 1; } finally { database.close(); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Another process with a read transaction open on `databasePath` (the state it read stays in use) until released. */
async function holdReadSnapshot(databasePath) {
  const child = spawn(process.execPath, ['-e', [
    'const D = require("better-sqlite3"); const d = new D(process.argv[1]); d.pragma("busy_timeout = 5000");',
    'd.exec("BEGIN"); d.prepare("SELECT COUNT(*) FROM conversation").get(); process.stdout.write("ready\\n");',
    'process.stdin.on("end", () => { d.exec("COMMIT"); d.close(); process.exit(0); }); process.stdin.resume();'
  ].join(' '), databasePath], { stdio: ['pipe', 'pipe', 'inherit'] });
  await waitForLine(child, 'ready');
  return { release: () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end(); }) };
}

async function startChurn(fixture) {
  const child = spawn(process.execPath, [TEST_FILE], {
    env: { ...process.env, LIMCODE_DATABASE_SNAPSHOT_CHILD: 'churn', LIMCODE_DATABASE_SNAPSHOT_INPUT: JSON.stringify({ scopeRoot: fixture.current.scopeRoot }) },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  await waitForLine(child, 'ready');
  const churn = {
    commits: 0,
    stop: async () => {
      const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
      child.stdin.end();
      assert.equal(await exited, 0, output);
      churn.commits = Number(/commits (\d+)/.exec(output)?.[1]);
    }
  };
  return churn;
}

function waitForLine(child, line) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const onData = (chunk) => {
      seen += chunk;
      if (seen.split('\n').includes(line)) { child.stdout.off('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => reject(new Error(`子进程没有就绪就退出了（${code}）：${seen}`)));
  });
}

function run(args) {
  return new Promise((resolve, reject) => execFile(process.execPath, args, (error) => error ? reject(error) : resolve()));
}

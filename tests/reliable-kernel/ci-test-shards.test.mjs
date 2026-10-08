import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CI_SHARD_COUNT, createCiShardPlan, parseCiShard, verifyCiShardReports
} from '../../scripts/reliable-kernel/lib/ci-test-shards.mjs';

import { RELOCATION_UNDO_CRASH_SCENARIOS, RELOCATION_UNDO_CRASH_GROUPS } from './runtime-data-root-relocation-undo-crash-scenarios.mjs';

const runner = path.resolve('scripts/reliable-kernel/run-local-tests.mjs');
const list = (...options) => childProcess.execFileSync(process.execPath, [runner, '--ci', '--list', ...options], {
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
}).trim().split('\n');
const files = list();
const plan = createCiShardPlan(files);
const goodReports = () => plan.shards.map((shard) => ({
  kind: 'limcode-ci-test-shard', commit: 'expected-commit',
  index: shard.index, count: shard.count,
  assignedFiles: shard.files, completed: true, status: 0,
  results: shard.files.map((file) => ({ file, status: 0, signal: null, timedOut: false, durationMs: 1 }))
}));

test('weighted CI shards cover every registered file exactly once in deterministic serial order', () => {
  assert.equal(plan.shards.length, CI_SHARD_COUNT);
  assert.deepEqual(createCiShardPlan([...files].reverse()), plan, 'input discovery order cannot change assignment');
  const flattened = plan.shards.flatMap((shard) => shard.files);
  assert.equal(new Set(flattened).size, files.length);
  assert.deepEqual([...flattened].sort(), files);
  for (const shard of plan.shards) {
    assert.ok(shard.files.length > 0);
    assert.deepEqual(shard.files, [...shard.files].sort());
    assert.deepEqual(list('--shard', `${shard.index}/${shard.count}`), shard.files, 'execution CLI uses the audited plan');
  }
});

test('longest-processing-time allocation isolates expensive files without dropping unknown files', () => {
  const timings = { defaultDurationMs: 1, files: { a: 100, b: 50, c: 49 } };
  const weighted = createCiShardPlan(['d', 'c', 'b', 'a'], 2, timings);
  assert.deepEqual(weighted.shards.map((shard) => shard.files), [['a'], ['b', 'c', 'd']]);
  assert.deepEqual(weighted.shards.map((shard) => shard.estimatedDurationMs), [100, 100]);
});

test('invalid shard selections and duplicate registrations fail closed', () => {
  for (const value of ['', '0/12', '13/12', '1/0', '1.5/12', '1/12junk', '1/9007199254740992']) {
    assert.throws(() => parseCiShard(value));
  }
  for (const count of [0, -1, 1.5, files.length + 1]) assert.throws(() => createCiShardPlan(files, count));
  assert.throws(() => createCiShardPlan(['a', 'a'], 1), /duplicate/);
  assert.deepEqual(parseCiShard('1/12'), { index: 1, count: 12 });
});

test('aggregate accepts only a complete exactly-once successful run for the expected commit', () => {
  assert.equal(verifyCiShardReports(plan, goodReports(), 'expected-commit').length, files.length);
  const changes = [
    (reports) => reports.pop(),
    (reports) => reports.push(reports[0]),
    (reports) => { reports[0].index = 999; },
    (reports) => { reports[0].completed = false; },
    (reports) => { reports[0].status = 1; },
    (reports) => { reports[0].commit = 'other-commit'; },
    (reports) => { reports[0].count += 1; },
    (reports) => { reports[0].assignedFiles = []; },
    (reports) => { reports[0].results = []; },
    (reports) => { reports[0].results.push(reports[0].results[0]); },
    (reports) => { reports[0].results[0].status = 1; },
    (reports) => { reports[0].results[0].signal = 'SIGTERM'; },
    (reports) => { reports[0].results[0].timedOut = true; },
    (reports) => { reports[0].results[0].durationMs = -1; }
  ];
  for (const change of changes) {
    const reports = goodReports();
    change(reports);
    assert.throws(() => verifyCiShardReports(plan, reports, 'expected-commit'), /coverage failed/);
  }
});

test('sharded runner continues after a file failure and reports every assigned file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-ci-shard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixturePlan = createCiShardPlan(files, 2);
  const shard = fixturePlan.shards.find((candidate) => !candidate.files.some((file) => file.endsWith('.ts')));
  // If weights put webview files on both halves, use a small all-JS shard instead.
  const selectedPlan = shard ? fixturePlan : createCiShardPlan(files, Math.ceil(files.length / 2));
  const selected = shard ?? selectedPlan.shards.find((candidate) => candidate.files.length >= 2
    && !candidate.files.some((file) => file.endsWith('.ts')));
  assert.ok(selected, 'fixture must exercise at least two Node test files');
  for (const file of files) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, '');
  }
  // A failure in the first file must not conceal later file results.
  fs.writeFileSync(path.join(root, selected.files[0]), 'throw new Error("intentional shard fixture failure");\n');
  const reportPath = path.join(root, 'report.json');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const outcome = childProcess.spawnSync(process.execPath, [runner, '--ci', '--shard', `${selected.index}/${selected.count}`, '--report', reportPath], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(outcome.status, 1, outcome.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.completed, true, 'all assigned files still ran');
  assert.equal(report.status, 1);
  assert.deepEqual(report.results.map((result) => result.file), selected.files);
  assert.equal(report.results[0].status, 1);
  assert.ok(report.results.slice(1).every((result) => result.status === 0));
  assert.deepEqual(fs.readdirSync(path.join(root, 'node_modules', '.cache')), [], 'runner still cleans its owned build');
});


test('relocation crash entries cover every reachable current-only relocation crash exactly once', () => {
  const scenarios = RELOCATION_UNDO_CRASH_SCENARIOS;
  assert.equal(scenarios.length, 96);
  const covered = [];
  for (const group of RELOCATION_UNDO_CRASH_GROUPS) {
    const suffix = group === 'empty' ? '' : `-${group}`;
    const file = `tests/reliable-kernel/runtime-data-root-relocation-undo-crash${suffix}.test.mjs`;
    assert.ok(files.includes(file), 'every group entry must be registered in CI');
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, new RegExp(`registerRelocationUndoCrashTests\\('${group}'\\);`));
    assert.equal((source.match(/registerRelocationUndoCrashTests\(/g) ?? []).length, 1);
    const groupCases = scenarios.filter((scenario) => scenario[1] === group);
    assert.ok(groupCases.length > 0, 'a zero-selected entry cannot pass inventory verification');
    covered.push(...groupCases.map((scenario) => JSON.stringify(scenario)));
  }
  assert.equal(new Set(covered).size, 96);
  assert.deepEqual(covered.sort(), scenarios.map((scenario) => JSON.stringify(scenario)).sort());
});

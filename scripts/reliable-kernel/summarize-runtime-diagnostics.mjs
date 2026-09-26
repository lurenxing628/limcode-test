#!/usr/bin/env node
// 汇总可靠 Runtime 诊断环（diagnostics/events*.jsonl）：Feed 全量快照按原因的占比、
// 写锁等待/持锁分布、SQLITE_BUSY、WAL checkpoint 积压和 CAS 发布耗时。
// 只读取诊断文件，不打开 SQLite，也不读取任何正文。
//
// 用法：node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs [--json] <数据根或 diagnostics 目录>
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BUCKETS = ['1', '2', '5', '10', '25', '50', '100', '250', '500', '1000', '2500', '5000', '10000', '30000', 'inf'];

function usage(message) {
  if (message) console.error(message);
  console.error('用法：node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs [--json] <数据根或 diagnostics 目录>');
  process.exit(2);
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const target = args.find((arg) => arg !== '--json');
if (!target) usage();
const directory = fs.existsSync(path.join(target, 'events.jsonl')) || !fs.existsSync(path.join(target, 'diagnostics'))
  ? target
  : path.join(target, 'diagnostics');
if (!fs.existsSync(directory)) usage(`找不到诊断目录：${directory}`);

const events = [];
for (const name of ['events.3.jsonl', 'events.2.jsonl', 'events.1.jsonl', 'events.jsonl']) {
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event?.schema === 'limcode-reliable-diagnostic' && typeof event.eventKind === 'string') events.push(event);
    } catch {
      // 轮转时截断的最后一行不影响汇总。
    }
  }
}
events.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));

const summaries = (kind) => events.filter((event) => event.eventKind === `${kind}.summary`);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function emptyHistogram() {
  return { counts: new Array(BUCKETS.length).fill(0), max: 0, total: 0 };
}

function mergeHistogram(into, metadata) {
  if (typeof metadata.histogramMs !== 'string') return;
  for (const part of metadata.histogramMs.split(',')) {
    const [bound, count] = part.split(':');
    const index = BUCKETS.indexOf(bound);
    if (index >= 0) into.counts[index] += Number(count) || 0;
  }
  into.max = Math.max(into.max, number(metadata.maxMs));
  into.total += number(metadata.totalMs);
}

function describeHistogram(histogram) {
  const count = histogram.counts.reduce((sum, value) => sum + value, 0);
  const quantile = (q) => {
    if (count === 0) return null;
    const target = Math.max(1, Math.ceil(count * q));
    let cumulative = 0;
    for (let index = 0; index < BUCKETS.length; index += 1) {
      cumulative += histogram.counts[index];
      if (cumulative >= target) return BUCKETS[index] === 'inf' ? histogram.max : Math.min(Number(BUCKETS[index]), histogram.max);
    }
    return histogram.max;
  };
  return {
    count,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: count ? histogram.max : null,
    meanMs: count ? Math.round((histogram.total / count) * 1000) / 1000 : null,
    buckets: Object.fromEntries(BUCKETS.map((bound, index) => [bound, histogram.counts[index]]).filter(([, value]) => value > 0))
  };
}

function histogramsBy(kind, key) {
  const groups = new Map([['*', emptyHistogram()]]);
  for (const event of summaries(kind)) {
    const group = String(event.metadata[key] ?? '-');
    if (!groups.has(group)) groups.set(group, emptyHistogram());
    mergeHistogram(groups.get(group), event.metadata);
    mergeHistogram(groups.get('*'), event.metadata);
  }
  return Object.fromEntries([...groups].map(([group, histogram]) => [group, describeHistogram(histogram)]));
}

// Feed 全量快照：按原因统计次数与字节，外部提交（其它宿主写入）单列占比。
const snapshotReasons = {};
for (const event of summaries('feed.snapshot')) {
  const reason = String(event.metadata.reasonCode ?? '-');
  snapshotReasons[reason] ??= { count: 0, bytes: 0 };
  snapshotReasons[reason].count += number(event.metadata.sampleCount);
  snapshotReasons[reason].bytes += number(event.metadata.bytes);
}
const snapshotTotal = Object.values(snapshotReasons).reduce((sum, entry) => ({ count: sum.count + entry.count, bytes: sum.bytes + entry.bytes }), { count: 0, bytes: 0 });
const external = snapshotReasons.external_commit ?? { count: 0, bytes: 0 };
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : null);

const busyGroups = {};
for (const event of summaries('database.busy')) {
  const key = ['requestKind', 'stage', 'domain', 'reasonCode'].map((field) => event.metadata[field] ?? '-').join(' / ');
  busyGroups[key] = (busyGroups[key] ?? 0) + number(event.metadata.sampleCount);
}
const slow = events.filter((event) => event.eventKind === 'database.write_lock.slow')
  .map((event) => ({ observedAt: event.observedAt, ...event.metadata }))
  .sort((left, right) => number(right.lockWaitMs) + number(right.holdMs) - number(left.lockWaitMs) - number(left.holdMs));
const walEvents = events.filter((event) => event.eventKind === 'database.wal' || event.eventKind === 'database.wal.checkpoint_lagging');
const cas = {};
for (const event of summaries('cas.prepare')) {
  const operation = String(event.metadata.operation ?? '-');
  cas[operation] ??= { histogram: emptyHistogram(), publishes: 0, fileFsyncs: 0, directoryFsyncs: 0 };
  mergeHistogram(cas[operation].histogram, event.metadata);
  cas[operation].publishes += number(event.metadata.publishes);
  cas[operation].fileFsyncs += number(event.metadata.fileFsyncs);
  cas[operation].directoryFsyncs += number(event.metadata.directoryFsyncs);
}

const kinds = {};
for (const event of events) kinds[event.eventKind] = (kinds[event.eventKind] ?? 0) + 1;
const first = events[0]?.observedAt ?? null;
const last = events.at(-1)?.observedAt ?? null;

const report = {
  directory,
  coverage: {
    events: events.length,
    from: first,
    to: last,
    hours: first && last ? Math.round(((Date.parse(last) - Date.parse(first)) / 3_600_000) * 100) / 100 : 0,
    topEventKinds: Object.fromEntries(Object.entries(kinds).sort((left, right) => right[1] - left[1]).slice(0, 15))
  },
  feedSnapshots: {
    byReason: snapshotReasons,
    total: snapshotTotal,
    externalCommitCountSharePercent: share(external.count, snapshotTotal.count),
    externalCommitBytesSharePercent: share(external.bytes, snapshotTotal.bytes),
    externalChangeDetections: summaries('feed.external_change').reduce((sum, event) => sum + number(event.metadata.sampleCount), 0)
  },
  writeLockWaitMs: histogramsBy('database.write_lock_wait', 'requestKind'),
  writeLockHoldMs: histogramsBy('database.write_lock_hold', 'requestKind'),
  workerQueueWaitMs: histogramsBy('database.queue_wait', 'requestKind')['*'],
  busy: {
    total: Object.values(busyGroups).reduce((sum, value) => sum + value, 0),
    byLocation: busyGroups,
    samples: events.filter((event) => event.eventKind === 'database.busy').slice(-10).map((event) => ({ observedAt: event.observedAt, ...event.metadata }))
  },
  slowWriteLocks: { persisted: slow.length, worst: slow.slice(0, 10) },
  wal: {
    samples: walEvents.length,
    lagging: walEvents.filter((event) => event.eventKind === 'database.wal.checkpoint_lagging').length,
    maxWalBytes: Math.max(0, ...walEvents.map((event) => number(event.metadata.walBytes))),
    maxPendingFrames: Math.max(0, ...walEvents.map((event) => number(event.metadata.pendingFrames))),
    last: walEvents.at(-1)?.metadata ?? null
  },
  casPrepare: Object.fromEntries(Object.entries(cas).map(([operation, entry]) => [operation, {
    ...describeHistogram(entry.histogram),
    publishes: entry.publishes,
    fileFsyncs: entry.fileFsyncs,
    directoryFsyncs: entry.directoryFsyncs
  }]))
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ms = (value) => (value === null ? '-' : `${value}ms`);
  const line = (label, histogram) => `${label}: n=${histogram.count} p50≤${ms(histogram.p50Ms)} p95≤${ms(histogram.p95Ms)} p99≤${ms(histogram.p99Ms)} max=${ms(histogram.maxMs)}`;
  console.log(`诊断目录：${directory}`);
  console.log(`覆盖：${report.coverage.events} 条事件，${first ?? '-'} → ${last ?? '-'}（约 ${report.coverage.hours} 小时）`);
  console.log('\n[Feed 全量快照]');
  for (const [reason, entry] of Object.entries(snapshotReasons)) {
    console.log(`  ${reason}: ${entry.count} 次，${entry.bytes} 字节（次数占比 ${share(entry.count, snapshotTotal.count)}%）`);
  }
  console.log(`  外部提交引起：次数占比 ${report.feedSnapshots.externalCommitCountSharePercent ?? '-'}%，字节占比 ${report.feedSnapshots.externalCommitBytesSharePercent ?? '-'}%；外部变化检测 ${report.feedSnapshots.externalChangeDetections} 次`);
  console.log('\n[写锁等待 BEGIN IMMEDIATE]');
  for (const [kind, histogram] of Object.entries(report.writeLockWaitMs)) console.log(`  ${line(kind, histogram)}`);
  console.log('\n[写锁持有]');
  for (const [kind, histogram] of Object.entries(report.writeLockHoldMs)) console.log(`  ${line(kind, histogram)}`);
  console.log(`\n[worker 排队] ${line('全部', report.workerQueueWaitMs)}`);
  console.log(`\n[SQLITE_BUSY / locked] 共 ${report.busy.total} 次`);
  for (const [location, count] of Object.entries(busyGroups)) console.log(`  ${location}: ${count}`);
  console.log(`\n[慢写锁（等待或持有 ≥250ms）] 已记录 ${slow.length} 条`);
  for (const entry of slow.slice(0, 5)) console.log(`  ${entry.observedAt} ${entry.requestKind}/${entry.domain ?? '-'} 等待 ${ms(entry.lockWaitMs ?? null)} 持有 ${ms(entry.holdMs ?? null)}`);
  console.log(`\n[WAL] 采样 ${report.wal.samples} 次，积压告警 ${report.wal.lagging} 次，最大 WAL ${report.wal.maxWalBytes} 字节，最大未 checkpoint 帧 ${report.wal.maxPendingFrames}`);
  console.log('\n[CAS 准备/发布]');
  for (const [operation, entry] of Object.entries(report.casPrepare)) {
    console.log(`  ${line(operation, entry)} 发布 ${entry.publishes} 文件 fsync ${entry.fileFsyncs} 目录 fsync ${entry.directoryFsyncs}`);
  }
}

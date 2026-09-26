#!/usr/bin/env node
// 汇总可靠 Runtime 诊断环（diagnostics/events*.jsonl）：Feed 全量快照按原因的占比、
// 各类数据库请求（含读请求）的耗时分布、写锁等待/持锁分布、SQLITE_BUSY、WAL 大小和 CAS 发布耗时，
// 并按 Host（hostBootId）分组。只读取诊断文件，不打开 SQLite，也不读取任何正文。
//
// 用法：node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs [--json] [--all] <数据根或 diagnostics 目录>
//   默认只统计诊断环保留期（7 天）内的事件；--all 统计文件里的全部事件。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const BUCKETS = ['1', '2', '5', '10', '25', '50', '100', '250', '500', '1000', '2500', '5000', '10000', '30000', 'inf'];

function usage(message) {
  if (message) console.error(message);
  console.error('用法：node scripts/reliable-kernel/summarize-runtime-diagnostics.mjs [--json] [--all] <数据根或 diagnostics 目录>');
  process.exit(2);
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const all = args.includes('--all');
const target = args.find((arg) => !arg.startsWith('--'));
if (!target) usage();
const directory = fs.existsSync(path.join(target, 'events.jsonl')) || !fs.existsSync(path.join(target, 'diagnostics'))
  ? target
  : path.join(target, 'diagnostics');
if (!fs.existsSync(directory)) usage(`找不到诊断目录：${directory}`);

const cutoffMs = all ? Number.NEGATIVE_INFINITY : Date.now() - RETENTION_MS;
const events = [];
let skippedLines = 0;
for (const name of ['events.3.jsonl', 'events.2.jsonl', 'events.1.jsonl', 'events.jsonl']) {
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 轮转时截断的最后一行不影响汇总。
      skippedLines += 1;
      continue;
    }
    const observedMs = Date.parse(parsed?.observedAt);
    if (parsed?.schema !== 'limcode-reliable-diagnostic' || typeof parsed.eventKind !== 'string' || !Number.isFinite(observedMs)) {
      skippedLines += 1;
      continue;
    }
    if (observedMs < cutoffMs) continue;
    const metadata = parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata) ? parsed.metadata : {};
    events.push({ ...parsed, metadata, observedMs });
  }
}
events.sort((left, right) => left.observedMs - right.observedMs);

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : null);

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
    const goal = Math.max(1, Math.ceil(count * q));
    let cumulative = 0;
    for (let index = 0; index < BUCKETS.length; index += 1) {
      cumulative += histogram.counts[index];
      if (cumulative >= goal) return BUCKETS[index] === 'inf' ? histogram.max : Math.min(Number(BUCKETS[index]), histogram.max);
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

function summarize(scope) {
  const summaries = (kind) => scope.filter((event) => event.eventKind === `${kind}.summary`);
  const histogramsBy = (kind, key) => {
    const groups = new Map([['*', emptyHistogram()]]);
    for (const event of summaries(kind)) {
      const group = String(event.metadata[key] ?? '-');
      if (!groups.has(group)) groups.set(group, emptyHistogram());
      mergeHistogram(groups.get(group), event.metadata);
      mergeHistogram(groups.get('*'), event.metadata);
    }
    return Object.fromEntries([...groups].map(([group, histogram]) => [group, describeHistogram(histogram)]));
  };

  // Feed 全量快照：按原因统计次数与字节，外部提交（其它 Host/连接写入）单列占比。
  const snapshotReasons = {};
  for (const event of summaries('feed.snapshot')) {
    const reason = String(event.metadata.reasonCode ?? '-');
    snapshotReasons[reason] ??= { count: 0, bytes: 0 };
    snapshotReasons[reason].count += number(event.metadata.sampleCount);
    snapshotReasons[reason].bytes += number(event.metadata.bytes);
  }
  const snapshotTotal = Object.values(snapshotReasons)
    .reduce((sum, entry) => ({ count: sum.count + entry.count, bytes: sum.bytes + entry.bytes }), { count: 0, bytes: 0 });
  const external = snapshotReasons.external_commit ?? { count: 0, bytes: 0 };

  const requestErrors = {};
  for (const event of summaries('database.request')) {
    if (event.metadata.status !== 'error') continue;
    const kind = String(event.metadata.requestKind ?? '-');
    requestErrors[kind] = (requestErrors[kind] ?? 0) + number(event.metadata.sampleCount);
  }
  const busyGroups = {};
  for (const event of summaries('database.busy')) {
    const key = ['requestKind', 'stage', 'domain', 'reasonCode'].map((field) => event.metadata[field] ?? '-').join(' / ');
    busyGroups[key] = (busyGroups[key] ?? 0) + number(event.metadata.sampleCount);
  }
  const slow = scope.filter((event) => event.eventKind === 'database.write_lock.slow')
    .map((event) => ({ observedAt: event.observedAt, ...event.metadata }))
    .sort((left, right) => number(right.lockWaitMs) + number(right.holdMs) - number(left.lockWaitMs) - number(left.holdMs));
  const walEvents = scope.filter((event) => event.eventKind === 'database.wal' || event.eventKind === 'database.wal.growing');
  const cas = {};
  for (const event of summaries('cas.prepare')) {
    const operation = String(event.metadata.operation ?? '-');
    cas[operation] ??= { histogram: emptyHistogram(), publishes: 0, lookupHits: 0, lookupMisses: 0, fileFsyncs: 0, directoryFsyncs: 0 };
    mergeHistogram(cas[operation].histogram, event.metadata);
    for (const field of ['publishes', 'lookupHits', 'lookupMisses', 'fileFsyncs', 'directoryFsyncs']) {
      cas[operation][field] += number(event.metadata[field]);
    }
  }

  return {
    feedSnapshots: {
      byReason: snapshotReasons,
      total: snapshotTotal,
      externalCommitCountSharePercent: share(external.count, snapshotTotal.count),
      externalCommitBytesSharePercent: share(external.bytes, snapshotTotal.bytes),
      externalChangeDetections: summaries('feed.external_change').reduce((sum, event) => sum + number(event.metadata.sampleCount), 0)
    },
    // 每类 worker 请求（读请求如 clientProjectionSnapshot、conversationHistoryProjection、externalDataVersion）的往返耗时。
    databaseRequestMs: histogramsBy('database.request', 'requestKind'),
    databaseRequestErrors: requestErrors,
    writeLockWaitMs: histogramsBy('database.write_lock_wait', 'requestKind'),
    writeLockHoldMs: histogramsBy('database.write_lock_hold', 'requestKind'),
    workerQueueWaitMs: histogramsBy('database.queue_wait', 'requestKind')['*'],
    busy: {
      total: Object.values(busyGroups).reduce((sum, value) => sum + value, 0),
      byLocation: busyGroups,
      samples: scope.filter((event) => event.eventKind === 'database.busy').slice(-10)
        .map((event) => ({ observedAt: event.observedAt, ...event.metadata }))
    },
    slowWriteLocks: { persisted: slow.length, worst: slow.slice(0, 10) },
    wal: {
      samples: walEvents.length,
      growing: walEvents.filter((event) => event.eventKind === 'database.wal.growing').length,
      maxWalBytes: Math.max(0, ...walEvents.map((event) => number(event.metadata.walBytes))),
      last: walEvents.at(-1)?.metadata ?? null
    },
    casPrepare: Object.fromEntries(Object.entries(cas).map(([operation, entry]) => [operation, {
      ...describeHistogram(entry.histogram),
      publishes: entry.publishes,
      lookupHits: entry.lookupHits,
      lookupMisses: entry.lookupMisses,
      fileFsyncs: entry.fileFsyncs,
      directoryFsyncs: entry.directoryFsyncs
    }]))
  };
}

const kinds = {};
for (const event of events) kinds[event.eventKind] = (kinds[event.eventKind] ?? 0) + 1;
const first = events[0]?.observedAt ?? null;
const last = events.at(-1)?.observedAt ?? null;
const hostIds = [...new Set(events.map((event) => event.metadata.hostBootId).filter((id) => typeof id === 'string' && id))].sort();

const report = {
  directory,
  coverage: {
    events: events.length,
    skippedLines,
    retentionFiltered: !all,
    from: first,
    to: last,
    hours: first && last ? Math.round(((Date.parse(last) - Date.parse(first)) / 3_600_000) * 100) / 100 : 0,
    topEventKinds: Object.fromEntries(Object.entries(kinds).sort((left, right) => right[1] - left[1]).slice(0, 15))
  },
  ...summarize(events),
  hosts: Object.fromEntries(hostIds.map((hostBootId) => [
    hostBootId,
    summarize(events.filter((event) => event.metadata.hostBootId === hostBootId))
  ]))
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ms = (value) => (value === null || value === undefined ? '-' : `${value}ms`);
  const line = (label, histogram) => `${label}: n=${histogram.count} p50≤${ms(histogram.p50Ms)} p95≤${ms(histogram.p95Ms)} p99≤${ms(histogram.p99Ms)} max=${ms(histogram.maxMs)}`;
  const print = (section, prefix = '') => {
    console.log(`${prefix}[Feed 全量快照]`);
    for (const [reason, entry] of Object.entries(section.feedSnapshots.byReason)) {
      console.log(`${prefix}  ${reason}: ${entry.count} 次，${entry.bytes} 字节（次数占比 ${share(entry.count, section.feedSnapshots.total.count)}%）`);
    }
    console.log(`${prefix}  外部提交引起：次数占比 ${section.feedSnapshots.externalCommitCountSharePercent ?? '-'}%，字节占比 ${section.feedSnapshots.externalCommitBytesSharePercent ?? '-'}%；外部变化检测 ${section.feedSnapshots.externalChangeDetections} 次`);
    console.log(`${prefix}[数据库请求往返（按 requestKind）]`);
    for (const [kind, histogram] of Object.entries(section.databaseRequestMs)) {
      console.log(`${prefix}  ${line(kind, histogram)}${section.databaseRequestErrors[kind] ? ` 失败 ${section.databaseRequestErrors[kind]}` : ''}`);
    }
    console.log(`${prefix}[写锁等待 BEGIN IMMEDIATE]`);
    for (const [kind, histogram] of Object.entries(section.writeLockWaitMs)) console.log(`${prefix}  ${line(kind, histogram)}`);
    console.log(`${prefix}[写锁持有]`);
    for (const [kind, histogram] of Object.entries(section.writeLockHoldMs)) console.log(`${prefix}  ${line(kind, histogram)}`);
    console.log(`${prefix}[worker 排队] ${line('全部', section.workerQueueWaitMs)}`);
    console.log(`${prefix}[SQLITE_BUSY / locked] 共 ${section.busy.total} 次`);
    for (const [location, count] of Object.entries(section.busy.byLocation)) console.log(`${prefix}  ${location}: ${count}`);
    console.log(`${prefix}[慢写锁（等待或持有 ≥250ms）] 已记录 ${section.slowWriteLocks.persisted} 条`);
    for (const entry of section.slowWriteLocks.worst.slice(0, 5)) {
      console.log(`${prefix}  ${entry.observedAt} ${entry.requestKind}/${entry.domain ?? '-'} 等待 ${ms(entry.lockWaitMs)} 持有 ${ms(entry.holdMs)}`);
    }
    console.log(`${prefix}[WAL] 采样 ${section.wal.samples} 次，持续增长告警 ${section.wal.growing} 次，最大 WAL ${section.wal.maxWalBytes} 字节`);
    console.log(`${prefix}[CAS 准备/发布]`);
    for (const [operation, entry] of Object.entries(section.casPrepare)) {
      console.log(`${prefix}  ${line(operation, entry)} 命中 ${entry.lookupHits} 未命中 ${entry.lookupMisses} 发布 ${entry.publishes} 文件 fsync ${entry.fileFsyncs} 目录 fsync ${entry.directoryFsyncs}`);
    }
  };
  console.log(`诊断目录：${directory}`);
  console.log(`覆盖：${report.coverage.events} 条事件${all ? '' : '（保留期 7 天内）'}，${first ?? '-'} → ${last ?? '-'}（约 ${report.coverage.hours} 小时）；跳过无法解析的行 ${skippedLines} 条`);
  console.log('口径：外部提交引起的 Feed 快照只含当前对话面板；侧栏历史列表的外部刷新走 Facade 的 ExternalDataVersionWatcher，');
  console.log('      其成本见下方 conversationHistoryProjection 与 externalDataVersion 两类请求，不计入 Feed 快照。\n');
  print(report);
  for (const [hostBootId, section] of Object.entries(report.hosts)) {
    console.log(`\n==== Host ${hostBootId} ====`);
    print(section, '  ');
  }
}

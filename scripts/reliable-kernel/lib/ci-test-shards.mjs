import fs from 'node:fs';

export const CI_SHARD_COUNT = 8;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function readCiTestTimings() {
  const timings = JSON.parse(fs.readFileSync(new URL('../ci-test-timings.json', import.meta.url), 'utf8'));
  if (!Number.isFinite(timings.defaultDurationMs) || timings.defaultDurationMs <= 0) {
    throw new Error('CI default test duration must be positive.');
  }
  for (const [file, duration] of Object.entries(timings.files)) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid CI test duration: ${file}`);
  }
  return timings;
}

/** Longest-processing-time first; ties use portable paths and shard index, never locale or time. */
export function createCiShardPlan(files, count = CI_SHARD_COUNT, timings = readCiTestTimings()) {
  if (!Number.isSafeInteger(count) || count < 1 || count > files.length) {
    throw new Error('CI shard count must be between 1 and the number of test files.');
  }
  if (new Set(files).size !== files.length) throw new Error('CI test list contains duplicate files.');
  const sorted = [...files].sort(compare);
  const duration = (file) => timings.files[file] ?? timings.defaultDurationMs;
  const shards = Array.from({ length: count }, (_, offset) => ({ index: offset + 1, count, files: [], estimatedDurationMs: 0 }));
  for (const file of [...sorted].sort((left, right) => duration(right) - duration(left) || compare(left, right))) {
    const shard = [...shards].sort((left, right) => left.estimatedDurationMs - right.estimatedDurationMs || left.index - right.index)[0];
    shard.files.push(file);
    shard.estimatedDurationMs += duration(file);
  }
  for (const shard of shards) shard.files.sort(compare);
  return { shards };
}

export function parseCiShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) throw new Error('--shard must be INDEX/COUNT (one-based).');
  const [, rawIndex, rawCount] = match;
  const index = Number(rawIndex);
  const count = Number(rawCount);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || count < 1 || index > count) {
    throw new Error('--shard index must be between 1 and count.');
  }
  return { index, count };
}

/** Missing, duplicate, partial, stale or failed shards must never make the aggregate check green. */
export function verifyCiShardReports(plan, reports, expectedCommit) {
  const failures = [];
  const seen = new Set();
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  for (const report of reports) {
    const shard = plan.shards.find((candidate) => candidate.index === report.index);
    if (!shard || seen.has(report.index)) {
      failures.push(`Unexpected or duplicate shard ${report.index}`);
      continue;
    }
    seen.add(report.index);
    if (report.kind !== 'limcode-ci-test-shard' || report.count !== shard.count
      || (expectedCommit && report.commit !== expectedCommit)) {
      failures.push(`Shard ${shard.index} has stale or invalid provenance`);
    }
    if (report.completed !== true || report.status !== 0) failures.push(`Shard ${shard.index} did not complete successfully`);
    if (!same(report.assignedFiles, shard.files)) failures.push(`Shard ${shard.index} assignment differs from the plan`);
    const results = Array.isArray(report.results) ? report.results : [];
    if (!same(results.map((result) => result.file), shard.files)) {
      failures.push(`Shard ${shard.index} has missing, duplicate or reordered test files`);
    }
    for (const result of results) {
      if (result.status !== 0 || result.signal !== null || result.timedOut !== false
        || !Number.isFinite(result.durationMs) || result.durationMs < 0) {
        failures.push(`Failed or invalid test result: ${result.file}`);
      }
    }
  }
  for (const shard of plan.shards) if (!seen.has(shard.index)) failures.push(`Missing shard ${shard.index}`);
  if (failures.length) throw new Error(`CI shard coverage failed:\n${failures.join('\n')}`);
  return reports.flatMap((report) => report.results);
}

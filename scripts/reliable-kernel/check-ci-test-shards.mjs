import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createCiShardPlan, verifyCiShardReports } from './lib/ci-test-shards.mjs';

const files = childProcess.execFileSync(process.execPath, ['scripts/reliable-kernel/run-local-tests.mjs', '--ci', '--list'], {
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
}).trim().split('\n');
const plan = createCiShardPlan(files);
if (process.argv.includes('--plan')) {
  const matrix = { include: plan.shards.map(({ index, count }) => ({ index, count })) };
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  console.log(JSON.stringify(plan, null, 2));
} else {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: check-ci-test-shards.mjs REPORT_DIRECTORY | --plan');
  const reports = fs.readdirSync(directory).filter((file) => /^shard-\d+\.json$/.test(file))
    .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
  // Job outcome is an independent fence: a file report cannot hide install/build/upload failures.
  if (process.env.CI_REQUIRED_JOB_RESULTS) {
    const jobs = JSON.parse(process.env.CI_REQUIRED_JOB_RESULTS);
    for (const [name, job] of Object.entries(jobs)) {
      if (job.result !== 'success') throw new Error(`Required CI job ${name} ended with ${job.result}`);
    }
  }
  const results = verifyCiShardReports(plan, reports, process.env.GITHUB_SHA);
  const rows = [...reports].sort((left, right) => left.index - right.index).map((report) => {
    const duration = report.results.reduce((total, result) => total + result.durationMs, 0);
    return `- Shard ${report.index}/${report.count}: ${report.results.length} files, ${(duration / 1000).toFixed(1)}s`;
  });
  const slowest = [...results].sort((left, right) => right.durationMs - left.durationMs).slice(0, 10)
    .map((result) => `- ${result.file}: ${(result.durationMs / 1000).toFixed(1)}s`);
  const summary = [
    `CI coverage verified: ${results.length} registered files executed exactly once across ${reports.length} isolated shards.`,
    '', ...rows, '', 'Slowest files:', ...slowest, ''
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

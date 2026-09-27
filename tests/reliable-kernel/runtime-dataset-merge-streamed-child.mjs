// A window running a large-merge session (runtime-dataset-merge-streamed*.test.mjs).
//   <configurationRoot> <options JSON>
// Opens the selected data set, prepares the sources online, closes its Runtime and runs the session
// inside the configuration admission and the target maintenance claim, as the caller of
// runLargeMergeSession does. With `fault` it SIGKILLs itself at that point; otherwise it prints the
// session results and its peak resident memory (VmHWM, kB) as JSON.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const { RuntimeDatabase } = kernelFile('runtimeDatabase.js');
const { prepareLargeMergeSources, runLargeMergeSession } = kernelFile('runtimeDataSetStreamedMerge.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { createVscodeRootAuthority, inspectVscodeRuntimeDataSets } = kernelFile('vscodeRootAuthority.js');
const { requireCompleteRuntimeDataSet } = kernelFile('runtimeStorageInspection.js');

const [root, raw] = process.argv.slice(2);
const input = JSON.parse(raw ?? '{}');
const paths = { globalStoragePath: root };
const selected = (await inspectVscodeRuntimeDataSets(paths)).candidates.find((candidate) => candidate.selected);
const authority = createVscodeRootAuthority({ runtimeDataRootPath: selected.runtimeDataRootPath, configurationRootPath: selected.configurationRootPath });
const fault = input.fault;
const onFaultPoint = async (point, detail = {}) => {
  if (!fault || point !== fault.point) return;
  if (fault.candidateId !== undefined && detail.candidateId !== fault.candidateId) return;
  if (fault.chunk !== undefined && detail.chunk !== fault.chunk) return;
  if (fault.index !== undefined && detail.index !== fault.index) return;
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
};
const options = {
  ...(input.sizeLimits ? { sizeLimits: input.sizeLimits } : {}),
  ...(input.chunkRows ? { chunkRows: input.chunkRows } : {}),
  ...(input.workerResourceLimits ? { workerResourceLimits: input.workerResourceLimits } : {}),
  onFaultPoint
};
const window = await RuntimeDatabase.open(authority, { hostBootId: `window-${randomUUID()}` });
let preparation;
try {
  preparation = await prepareLargeMergeSources({
    paths, target: { configurationRootPath: root, database: window },
    ...(input.candidateIds ? { candidateIds: input.candidateIds, requested: input.requested === true } : {}), options
  });
} finally {
  await window.close();
}
const targetPaths = (await requireCompleteRuntimeDataSet(selected)).paths;
const session = await withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(targetPaths,
  () => runLargeMergeSession({ paths, prepared: preparation, options })));
const status = await fs.readFile('/proc/self/status', 'utf8').catch(() => '');
const vmHwmKb = Number(/VmHWM:\s+(\d+) kB/.exec(status)?.[1] ?? 0);
process.stdout.write(JSON.stringify({
  prepared: preparation.sources.map((source) => ({ candidateId: source.candidateId, rows: source.rows, insertRows: source.insertRows })),
  report: preparation.report,
  results: session.results.map((result) => ({
    candidateId: result.candidateId, state: result.state, code: result.issue?.code, insertedRows: result.result?.insertedRows
  })),
  vmHwmKb
}));

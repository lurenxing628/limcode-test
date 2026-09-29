// Crash only this synthetic repair process, never a VS Code or user task process.
import fs from 'node:fs/promises';
import { kernelFile } from './fixtures/runtime-merge-fixture.mjs';
const { repairRuntimeHistory } = kernelFile('runtimeHistoryRepair.js');
const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
await repairRuntimeHistory(input.paths, input.plan, {
  onFaultPoint: (point) => { if (point === input.point) process.kill(process.pid, 'SIGKILL'); }
});
throw new Error('Expected crash boundary was not reached.');

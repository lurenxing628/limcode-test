// Child process of runtime-backup-cleanup.test.mjs: a window that crashes while deleting a backup.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');

const [mode, root, key] = process.argv.slice(2);
if (mode !== 'delete-then-crash') throw new Error(`unknown mode ${mode}`);
const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `crash-${randomUUID()}` });
const plan = await planRuntimeBackupCleanup(root, database);
await deleteRuntimeBackups(plan, database, [key], {
  // Killed after the durable rename, before the recursive removal (and with both claims held).
  onFaultPoint(point) { if (point === 'after-rename') process.kill(process.pid, 'SIGKILL'); }
});
process.exitCode = 3;

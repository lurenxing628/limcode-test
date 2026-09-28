// Child process of runtime-backup-cleanup(-foreign).test.mjs: a window that crashes while deleting a
// backup, or another process holding a claim (hold-claim <claim path> <target>) until told to release it.
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

const [mode, root, key, crashPoint = 'after-rename'] = process.argv.slice(2);
if (mode === 'hold-claim') {
  const { withRuntimeClaimAtPath } = kernelFile('runtimeHostControl.js');
  await withRuntimeClaimAtPath(root, key, async () => {
    process.stdout.write('held\n');
    // Given up after 15 s at the latest: a caller that waited for it instead of giving up proceeds then.
    await new Promise((resolve) => {
      process.stdin.once('data', resolve);
      process.stdin.once('end', resolve);
      setTimeout(resolve, 15_000).unref();
    });
  });
  process.exit(0);
}
if (mode !== 'delete-then-crash') throw new Error(`unknown mode ${mode}`);
if (!['after-rename', 'after-verify'].includes(crashPoint)) throw new Error(`unknown crash point ${crashPoint}`);
const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `crash-${randomUUID()}` });
const plan = await planRuntimeBackupCleanup(root, database);
await deleteRuntimeBackups(plan, database, [key], {
  // Killed with both claims held: after-rename before the coverage was checked again (no verified
  // mark yet), after-verify once the mark is durable and before the recursive removal.
  onFaultPoint(point) { if (point === crashPoint) process.kill(process.pid, 'SIGKILL'); }
});
// Not killed: the crash point was never reached.
await database.close().catch(() => undefined);
process.exit(3);

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCommittedRelocationFixture, loadRelocationModule } from './ci-storage-relocation-crash.mjs';

const require = createRequire(import.meta.url);
const sharedFs = require('node:fs/promises');
const relocation = loadRelocationModule('runtimeDataRootRelocation.js');
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { writeFileAtomicDurable } = require(path.join(compiled, 'backend/capabilities/vscodeStorage/durableWrite.js'));

async function main() {
  const base = process.argv[2];
  const { source, fixture, database } = await createCommittedRelocationFixture(base);
  let staged;
  try {
    const plan = await relocation.planDataRootRelocation({ sourceRootPath: source.root,
      targetRootPath: fixture.target, sourceDatabase: database });
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.target.kind, 'limcode');
    await writeFileAtomicDurable(path.join(base, 'pointer.json'), JSON.stringify({ dataRootPath: source.root,
      pendingRelocation: { relocationId: fixture.relocationId, sourceRootPath: source.root,
        targetRootPath: fixture.target, processId: process.pid } }));
    const originalOpen = sharedFs.open;
    sharedFs.open = async function (file, flags, ...rest) {
      const handle = await originalOpen.call(this, file, flags, ...rest);
      if (typeof file === 'string' && path.basename(file) === 'journal.jsonl' && flags === 'a') {
        const append = handle.appendFile.bind(handle);
        handle.appendFile = async (data, ...args) => {
          if (String(data).includes('"op":"received"')) process.kill(process.pid, 'SIGKILL');
          return append(data, ...args);
        };
      }
      return handle;
    };
    staged = await relocation.stageDataRootRelocation(plan, database, { relocationId: fixture.relocationId });
  } finally { await database.close(); }
  await relocation.completeDataRootRelocation(staged, async () => { throw new Error('crash must occur before publish'); },
    { pointerUnchanged: async () => true });
  throw new Error('received crash checkpoint was not reached');
}

main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });

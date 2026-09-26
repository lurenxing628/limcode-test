// Child process of runtime-data-root-relocation-crash.test.mjs. argv: <scenario> <base> <kind: empty|limcode>
// Prepares the old home (and, for 'limcode', an existing LimCode target), records the relocation as
// in progress in <base>/pointer.json the way the data-root pointer does, then runs stage + complete
// with a filesystem hook that SIGKILLs this process at the scenario's point.
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  compiled, createLimCodeTarget, planWithRuntime, populateFixture, relocate
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const [scenario, base, kind] = process.argv.slice(2);
const log = (message) => fsSync.appendFileSync(path.join(base, 'child.log'), `${scenario}: ${message}\n`);
const kill = (where) => { log(`SIGKILL at ${where}`); process.kill(process.pid, 'SIGKILL'); };
const { writeFileAtomicDurable } = require(path.join(compiled, 'backend/capabilities/vscodeStorage/durableWrite.js'));

async function main() {
  const fixture = await populateFixture(base);
  const target = path.join(base, 'target');
  if (kind === 'limcode') {
    await createLimCodeTarget(target, {
      agents: [{ id: 'agent-shared', name: 'target version' }, { id: 'agent-target-only', name: 'only in target' }]
    });
  }
  const pointer = path.join(base, 'pointer.json');
  const relocationId = randomUUID();
  fsSync.writeFileSync(path.join(base, 'fixture.json'), JSON.stringify({ root: fixture.root, target, relocationId, pid: process.pid }));
  const plan = await planWithRuntime(fixture, target);
  if (plan.problems.length) throw new Error(plan.problems.join('\n'));
  await writeFileAtomicDurable(pointer, JSON.stringify({
    dataRootPath: fixture.root,
    pendingRelocation: { relocationId, sourceRootPath: fixture.root, targetRootPath: target, processId: process.pid }
  }));

  let markerOpens = 0;
  const open = fsp.open;
  fsp.open = async function hookedOpen(file, ...rest) {
    if (typeof file === 'string' && file.endsWith('.tmp')) {
      if (path.basename(file).startsWith('.limcode-data-root-relocation.json.')) {
        markerOpens += 1;
        if (scenario === 'before-complete-marker' && markerOpens === 2) kill('completion record write (rows committed)');
      }
      if (scenario === 'config-index' && file.startsWith(`${path.join(target, 'agents', 'index.json')}.`)) {
        kill('agents index rewrite (previous version already in the backups)');
      }
    }
    return open.call(this, file, ...rest);
  };
  let links = 0;
  const link = fsp.link;
  fsp.link = async function hookedLink(from, to, ...rest) {
    if (typeof to === 'string' && to.startsWith(target) && scenario === 'stage-precopy' && ++links === 2) kill('CAS pre-copy');
    return link.call(this, from, to, ...rest);
  };
  const copyFile = fsp.copyFile;
  fsp.copyFile = async function hookedCopyFile(from, to, ...rest) {
    if (scenario === 'precopy-backup' && typeof from === 'string' && path.basename(from).startsWith('merge-precopy-')) {
      kill('pre-copy snapshot (Backup API staging beside the old database)');
    }
    return copyFile.call(this, from, to, ...rest);
  };
  const mkdir = fsp.mkdir;
  fsp.mkdir = async function hookedMkdir(directory, ...rest) {
    if (scenario === 'during-merge' && typeof directory === 'string' && directory.startsWith(target) && directory.includes('merge-backups')) {
      kill('merge (target backup, before the row commit)');
    }
    return mkdir.call(this, directory, ...rest);
  };

  await relocate(fixture, plan, {
    relocationId,
    publish: async () => {
      if (scenario === 'before-publish') kill('pointer switch (before the write)');
      await writeFileAtomicDurable(pointer, JSON.stringify({ dataRootPath: target }));
      if (scenario === 'after-publish') kill('pointer switch (after the write)');
    }
  });
  log('completed without kill');
}

main().then(() => process.exit(0), (error) => { log(`error ${error?.code ?? ''} ${error?.message}`); process.exit(3); });

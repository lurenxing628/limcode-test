// Child process of runtime-data-root-relocation-undo-crash.test.mjs (written from the reloc2 review's
// reproduction): a real SIGKILL at one durable step of a relocation, or of the undo that follows it.
// argv: <scenario> <base> <kind: empty|limcode|copied> [phase: relocate|recover]
// scenario syntax: "<point>" or "<point>:<n>" (n = 1-based occurrence). Points:
//   count                       run to completion, log every journal append
//   pending-written             right after the in-progress record (pointer.json) is written
//   journal-create              before the journal file is created
//   journal-before:<n>          before the n-th journal append
//   journal-after:<n>           after the n-th journal append (fsynced), before the step it announces
//   aside-after                 after the copied directory was renamed aside (before the staging record)
//   staging-marker-after        after the staging record was written
//   dbbackup-before-rename      offline copy of the receiving database complete, before its rename
//   selection-after             after the selection file is written (fresh root)
//   identity-after              after the identity file is written
//   complete-marker-after       after the completion record is written (before the moved notice)
//   notice-after                after the old directory's moved notice is written (== before publish)
//   publish-after               after the pointer switch
//   during-merge                killed inside the move: before the merge's row commit (existing target), after
//                               the first committed batch (fresh root)
//   undo-marked                 (phase recover) after the record was marked 'undoing', before any undo step
//   undo-restored               (phase recover) after the first replaced configuration file was put back
//   undo-merge-restored         (phase recover) after the first rewritten merge record (ledger, continuation) was put back
//   undo-db-restored            (phase recover) after the receiving database file was renamed back
//   undo-work-removed           (phase recover) after the journal directory was removed, before the record
//   undo-record-removed         (phase recover) after the record was removed (copied data not back yet)
//   undo-leftover-moved         (phase recover) after the target holding only dead claims moved to a sibling
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  compiled, createLimCodeTarget, planWithRuntime, populateFixture, relocate, relocation, treeSnapshot, writeRecordStore
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const MARKER = '.limcode-data-root-relocation.json';
const fsp = require('node:fs/promises');
const [scenario, base, kind, phase = 'relocate'] = process.argv.slice(2);
const [point, nText] = scenario.split(':');
const nth = Number(nText ?? '1');
const log = (message) => fsSync.appendFileSync(path.join(base, 'child.log'), `${scenario}/${kind}/${phase}: ${message}\n`);
const kill = (where) => { log(`SIGKILL at ${where}`); process.kill(process.pid, 'SIGKILL'); };
const { writeFileAtomicDurable } = require(path.join(compiled, 'backend/capabilities/vscodeStorage/durableWrite.js'));

const target = path.join(base, 'target');
const pointer = path.join(base, 'pointer.json');

function installHooks() {
  let appends = 0;
  const open = fsp.open;
  fsp.open = async function hookedOpen(file, flags, ...rest) {
    if (typeof file === 'string' && path.basename(file) === 'journal.jsonl') {
      if (flags === 'wx' && point === 'journal-create') kill('journal create');
      if (flags === 'a') {
        appends += 1;
        const index = appends;
        if (point === 'journal-before' && index === nth) kill(`before journal append #${index}`);
        const handle = await open.call(this, file, flags, ...rest);
        const close = handle.close.bind(handle);
        const append = handle.appendFile.bind(handle);
        handle.appendFile = async (data, ...more) => {
          if (point === 'count') log(`append #${index}: ${String(data).trim()}`);
          return append(data, ...more);
        };
        handle.close = async () => {
          await close();
          if (point === 'journal-after' && index === nth) kill(`after journal append #${index}`);
        };
        return handle;
      }
    }
    return open.call(this, file, flags, ...rest);
  };
  const rename = fsp.rename;
  let markerWrites = 0;
  fsp.rename = async function hookedRename(from, to, ...rest) {
    const toName = typeof to === 'string' ? path.basename(to) : '';
    if (point === 'dbbackup-before-rename' && typeof to === 'string' && /[\\/]database-[0-9a-f]{16}$/.test(to)) kill('receiving database backup rename');
    const result = await rename.call(this, from, to, ...rest);
    if (point === 'aside-after' && typeof to === 'string' && to.includes('.limcode-copied-')) kill('copied data renamed aside');
    if (toName === MARKER && phase === 'recover' && point === 'undo-marked') kill('undo: record marked undoing');
    if (point === 'undo-restored' && phase === 'recover' && String(from).includes(`${path.sep}configuration${path.sep}`)) {
      kill('undo: first replaced file put back');
    }
    if (point === 'undo-merge-restored' && phase === 'recover' && String(from).includes(`${path.sep}merge-records${path.sep}`)) {
      kill('undo: first rewritten merge record put back');
    }
    if (point === 'undo-leftover-moved' && phase === 'recover' && typeof to === 'string' && to.includes('.limcode-undone-')) {
      kill('undo: target with dead claims moved aside');
    }
    if (toName === MARKER) {
      markerWrites += 1;
      if (point === 'staging-marker-after' && markerWrites === 1) kill('staging record written');
      if (point === 'complete-marker-after' && phase === 'relocate' && markerWrites === 2) kill('completion record written');
    }
    if (point === 'notice-after' && toName === '.limcode-data-root-moved.json' && phase === 'relocate') kill('moved notice written');
    if (point === 'selection-after' && toName === '.limcode-runtime-selection.json' && phase === 'relocate') kill('selection written');
    if (point === 'identity-after' && toName === '.limcode-data-root-identity.json') kill('identity written');
    if (point === 'undo-db-restored' && phase === 'recover' && toName === 'limcode.sqlite' && String(from).includes('.limcode-relocation-backups')) {
      kill('undo: receiving database renamed back');
    }
    return result;
  };
  const mkdir = fsp.mkdir;
  fsp.mkdir = async function hookedMkdir(directory, ...rest) {
    if (point === 'during-merge' && phase === 'relocate' && typeof directory === 'string' && directory.startsWith(target) && directory.includes('merge-backups')) {
      kill('merge (target backup, before the row commit)');
    }
    return mkdir.call(this, directory, ...rest);
  };
  const rm = fsp.rm;
  fsp.rm = async function hookedRm(file, ...rest) {
    const result = await rm.call(this, file, ...rest);
    if (point === 'undo-work-removed' && phase === 'recover' && typeof file === 'string'
      && path.dirname(file) === path.join(target, '.limcode-relocation-backups')) kill('undo: journal directory removed');
    if (point === 'undo-record-removed' && phase === 'recover' && file === path.join(target, MARKER)) kill('undo: record removed');
    return result;
  };
  // A fresh root is written in batches (no merge backup): killed once the first batch is committed.
  if (point === 'during-merge' && phase === 'relocate' && kind !== 'limcode') {
    const { RuntimeDatabase } = require(path.join(compiled, 'backend/reliableKernel/runtimeDatabase.js'));
    const { resolveVscodeRuntimeDataRoot } = require(path.join(compiled, 'backend/reliableKernel/vscodeRootAuthority.js'));
    const receivingRoot = path.resolve(resolveVscodeRuntimeDataRoot({ globalStoragePath: target }));
    const transaction = RuntimeDatabase.prototype.transaction;
    RuntimeDatabase.prototype.transaction = async function hookedTransaction(...rest) {
      const result = await transaction.apply(this, rest);
      if (path.resolve(this.binding.paths.dataRootPath) === receivingRoot) kill('batched copy (first batch committed)');
      return result;
    };
  }
}

const tombstones = require(path.join(compiled, 'backend/reliableKernel/runtimeMergeTombstones.js'));
const { resolveVscodeRuntimeMergeLedgerRoot } = require(path.join(compiled, 'backend/reliableKernel/vscodeRootAuthority.js'));
const identityOf = (binding) => ({ dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId });

/**
 * What merges must never bring back, as the relocation carries it: a deletion record, a merge record
 * (with its closure) under alpha's candidate id and a continuation of the current data set; an
 * existing target keeps its own under the same names (the record is joined, the continuation extended).
 */
async function writeMergeBookkeeping(root, current, candidateId, conversationId) {
  const ledger = resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: root });
  await tombstones.recordRuntimeDeletedConversations(root, identityOf(current.binding), [conversationId]);
  const at = '2026-09-27T00:00:00.000Z';
  const source = { dataSetId: randomUUID(), rootInstanceId: randomUUID(), rootGeneration: 1, pointerRevision: 1, contentDigest: 'c'.repeat(64) };
  await fsp.mkdir(path.join(ledger, 'records'), { recursive: true });
  await fsp.writeFile(path.join(ledger, 'records', `${candidateId.replace(/:/g, '-')}.json`), `${JSON.stringify({
    kind: 'limcode-runtime-data-set-merge', candidateId, source, updatedAt: at, state: 'failed', code: 'x', message: 'x',
    mergedInto: [{ target: identityOf(current.binding), conversationIds: [conversationId] }]
  }, null, 2)}\n`);
  await fsp.mkdir(path.join(ledger, 'aliases'), { recursive: true });
  await fsp.writeFile(path.join(ledger, 'aliases', `${current.binding.dataSetId}.${current.binding.rootInstanceId}.json`), `${JSON.stringify({
    version: 1, continues: [{ dataSetId: randomUUID(), rootInstanceId: randomUUID(), relocationId: randomUUID(), at }]
  }, null, 2)}\n`);
}

async function prepare() {
  const fixture = await populateFixture(base);
  await writeMergeBookkeeping(fixture.root, fixture.current, fixture.alpha.id, 'conversation_deleted_source');
  await fsp.writeFile(path.join(fixture.root, 'AGENTS.md'), '# source rules\n');
  await fsp.writeFile(path.join(fixture.root, 'CLAUDE.md'), '# source claude\n');
  await fsp.mkdir(path.join(fixture.root, 'skills', 'shared'), { recursive: true });
  await fsp.writeFile(path.join(fixture.root, 'skills', 'shared', 'SKILL.md'), 'source skill\n');
  await writeRecordStore(path.join(fixture.root, 'settings'), 'llm-provider-configs', 'config', [
    { id: 'provider-shared', name: 'source', apiKey: 'sk-source' }, { id: 'provider-source-only', name: 'source only' }
  ]);
  if (kind === 'limcode') {
    const existing = await createLimCodeTarget(target, {
      agents: [{ id: 'agent-shared', name: 'target version' }, { id: 'agent-target-only', name: 'only in target' }]
    });
    await writeMergeBookkeeping(target, existing, fixture.alpha.id, 'conversation_deleted_target');
    await fsp.writeFile(path.join(target, 'AGENTS.md'), '# target rules\n');
    await fsp.mkdir(path.join(target, 'CLAUDE.md'));
    await fsp.writeFile(path.join(target, 'CLAUDE.md', 'note.txt'), 'a directory where the source has a file\n');
    await fsp.mkdir(path.join(target, 'skills', 'shared'), { recursive: true });
    await fsp.writeFile(path.join(target, 'skills', 'shared', 'SKILL.md'), 'target skill\n');
    await fsp.mkdir(path.join(target, 'settings'), { recursive: true });
    await fsp.writeFile(path.join(target, 'settings', 'llm.json'), '{"activeProviderConfigId":"target"}\n');
    await writeRecordStore(path.join(target, 'settings'), 'llm-provider-configs', 'config', [
      { id: 'provider-shared', name: 'target', apiKey: 'sk-target' }, { id: 'provider-target-only', name: 'target only' }
    ]);
  } else if (kind === 'copied') {
    const other = path.join(base, 'elsewhere');
    await createLimCodeTarget(other);
    await fsp.cp(other, target, { recursive: true });
    await fsp.rm(other, { recursive: true, force: true });
  }
  return fixture;
}

async function main() {
  if (phase === 'recover') {
    installHooks();
    const { relocationId } = JSON.parse(fsSync.readFileSync(path.join(base, 'fixture.json'), 'utf8'));
    log(`recover -> ${await relocation.recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId })}`);
    return;
  }
  const fixture = await prepare();
  const beforeTarget = fsSync.existsSync(target) ? await treeSnapshot(target) : null;
  fsSync.writeFileSync(path.join(base, 'before-target.json'), JSON.stringify(beforeTarget));
  const relocationId = randomUUID();
  fsSync.writeFileSync(path.join(base, 'fixture.json'), JSON.stringify({ root: fixture.root, target, relocationId, pid: process.pid }));
  const plan = await planWithRuntime(fixture, target);
  if (plan.problems.length) throw new Error(plan.problems.join('\n'));
  log(`plan kind ${plan.target.kind}`);
  fsSync.writeFileSync(path.join(base, 'ready'), '');
  await writeFileAtomicDurable(pointer, JSON.stringify({
    dataRootPath: fixture.root,
    pendingRelocation: { relocationId, sourceRootPath: fixture.root, targetRootPath: target, processId: process.pid }
  }));
  if (point === 'pending-written') kill('in-progress record written');
  installHooks();
  await relocate(fixture, plan, {
    relocationId,
    // Its moved notice is written into the old directory right before the switch; an undo removes it.
    movedBy: { id: path.join(base, 'installation'), label: 'crash child' },
    publish: async ({ dataRootId }) => {
      await writeFileAtomicDurable(pointer, JSON.stringify({ dataRootPath: target, dataRootId }));
      if (point === 'publish-after') kill('pointer switch');
    }
  });
  log('completed without kill');
}

main().then(() => process.exit(0), (error) => { log(`error ${error?.code ?? ''} ${error?.stack}`); process.exit(3); });

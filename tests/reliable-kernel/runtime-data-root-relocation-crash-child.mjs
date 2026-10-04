// Child process of runtime-data-root-relocation-crash.test.mjs. argv: <scenario> <base> <kind: empty|limcode>
// Prepares the old home (and, for 'limcode', an existing LimCode target), records the relocation as
// in progress in <base>/pointer.json the way the data-root pointer does, then runs stage + complete
// with a filesystem hook that SIGKILLs this process at the scenario's point.
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  compiled, createLimCodeTarget, kernelFile, NOW, planWithRuntime, populateFixture, PROJECT, relocate, repo, withRuntime
} from './runtime-data-root-relocation-fixture.mjs';

import { seedCollaborationMessages } from './fixtures/runtime-merge-fixture.mjs';

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
    const existing = await createLimCodeTarget(target, {
      ...(scenario === 'after-merge-commit' ? { conversations: [
        { id: 'conversation_existing_1', project: PROJECT }, { id: 'conversation_current_1', project: PROJECT }
      ] } : {}),
      agents: [{ id: 'agent-shared', name: 'target version' }, { id: 'agent-target-only', name: 'only in target' }]
    });
    if (scenario === 'after-merge-commit') {
      // Exercise both local inserts and an update of pre-existing target authority. The source
      // contributes an empty selected root to the shared conversation; the target has a ready
      // null-root pointer that the merge must demote atomically and recovery must restore exactly.
      const { emptyConversationContextHandleStateStep, pendingConversationContextHandleStateSteps } = kernelFile('conversationContextHandleState.js');
      await withRuntime(existing, database => database.transaction([emptyConversationContextHandleStateStep('conversation_current_1', NOW)]));
      await withRuntime(fixture.current, database => database.transaction([
        repo('ContextSequenceRoot').insert({ id: 'relocation_shared_root', conversation_id: 'conversation_current_1', root_seq: 1n,
          root_node_id: null, tail_node_id: null, tail_segment_count: 0n, segment_count: 0n, estimated_tokens: 0n, created_at: NOW }),
        repo('ConversationContextHeadLink').insert({ id: 'relocation_shared_head', conversation_id: 'conversation_current_1',
          root_id: 'relocation_shared_root', updated_at: NOW }),
        ...pendingConversationContextHandleStateSteps('conversation_current_1', NOW, undefined, 'relocation_shared_root')
      ]));
      const { timelineImportProvenanceRow } = kernelFile('timelinePosition.js');
      for (const [dataSet, from, to, names] of [
        [fixture.current, 'conversation_current_1', 'conversation_current_2', ['relocation_new_send', 'relocation_roundtrip_send']],
        [existing, 'conversation_existing_1', 'conversation_current_1', ['relocation_existing_send']]
      ]) {
        await withRuntime(dataSet, database => database.transaction([
          repo('Turn').insert({ id: `${from}_turn`, conversation_id: from, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
          repo('TurnTermination').insert({ id: `${from}_termination`, turn_id: `${from}_turn`, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
        ]));
        await seedCollaborationMessages(dataSet, from, to, names);
        await withRuntime(dataSet, database => database.transaction(names.flatMap((name, index) => {
          const row = { id: `${name}_timeline`, conversation_id: from, message_id: name,
            predecessor_message_id: `${from}_message`, predecessor_message_seq: 1n,
            exchange_seq: BigInt(index + 1), position_basis: 'committed', created_at: NOW };
          const { exchange_seq, ...withoutSequence } = row;
          const provenance = timelineImportProvenanceRow(repo('CollaborationSendTimelineLink').insertHistoricalTimelineImport(withoutSequence, {
            sourceDataSetId: dataSet.binding.dataSetId, sourceRootInstanceId: dataSet.binding.rootInstanceId, sourceExchangeSeq: exchange_seq
          }));
          return [repo('CollaborationSendTimelineLink').insertHistoricalCopy(row),
            // One source already carries the writer-generated edge; the other's edge is absent.
            // Target-owned provenance must survive the same undo proof unchanged.
            ...(name === 'relocation_new_send' ? [] : [repo('TimelineImportProvenance').insertHistoricalCopy(provenance)])];
        })));
      }
    }
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
    // The merge into an existing target committed (its rows journaled as 'merging' before), killed
    // before its 'received' journal entry: the undo must prove the target is only that plus these rows.
    if (scenario === 'after-merge-commit' && typeof file === 'string' && rest[0] === 'a') {
      const handle = await open.call(this, file, ...rest);
      const appendFile = handle.appendFile.bind(handle);
      handle.appendFile = async (data, ...more) => {
        if (String(data).includes('"op":"received"')) kill('merge committed, before the received journal entry');
        return appendFile(data, ...more);
      };
      return handle;
    }
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

  // An empty target is written in batches (no merge backup): killed once the first batch of the
  // current data set is committed in the receiving root.
  const { RuntimeDatabase } = require(path.join(compiled, 'backend/reliableKernel/runtimeDatabase.js'));
  const { resolveVscodeRuntimeDataRoot } = require(path.join(compiled, 'backend/reliableKernel/vscodeRootAuthority.js'));
  const receivingRoot = path.resolve(resolveVscodeRuntimeDataRoot({ globalStoragePath: target }));
  const transaction = RuntimeDatabase.prototype.transaction;
  RuntimeDatabase.prototype.transaction = async function hookedTransaction(...rest) {
    const result = await transaction.apply(this, rest);
    if (scenario === 'during-merge' && kind === 'empty' && path.resolve(this.binding.paths.dataRootPath) === receivingRoot) {
      kill('batched copy (first batch committed)');
    }
    return result;
  };

  await relocate(fixture, plan, {
    relocationId,
    publish: async () => {
      if (scenario === 'before-publish') kill('pointer switch (before the write)');
      // Like the real switch: the pointer names this relocation (only then may its installation confirm it).
      await writeFileAtomicDurable(pointer, JSON.stringify({ dataRootPath: target, lastMigration: { fromPath: fixture.root, toPath: target, relocationId } }));
      if (scenario === 'after-publish') kill('pointer switch (after the write)');
    }
  });
  log('completed without kill');
}

main().then(() => process.exit(0), (error) => { log(`error ${error?.code ?? ''} ${error?.message}`); process.exit(3); });

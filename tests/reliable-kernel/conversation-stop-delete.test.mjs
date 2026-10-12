import { before, after, test } from 'node:test';
import { openStopFixture } from './stop-control-fixture.mjs';
import { queueCancellationBeforeStop, pendingAnswerDeletionNotice, consumedAnswerDeletionNotice, backgroundChildDeletion, stopWholeTree,
  timeoutPreservesThenRetry, writerDeletionAtomicRefusal, durableStopRecovery } from './stop-delete-cases.mjs';
import { stopForeignProcess, liveOwnerStops, unknownDispatchIdentity, stopAllWaits, userStopsDeadHost, liveDispatchKeepsReceipt,
  recoverDispatchedSpawn, rejectCancelRace } from './stop-control-cases.mjs';
let f;
before(async () => { f = await openStopFixture(); });
after(async () => { await f?.close(); });
test('queued intent cancellation commits before stop and blocks any admission during deletion', () => queueCancellationBeforeStop(f));
test('deleting a pending child answer substitutes a notification and lets the parent continue', () => pendingAnswerDeletionNotice(f));
test('deleting an accepted but unabsorbed child answer substitutes a notification', () => consumedAnswerDeletionNotice(f));
test('deleting a background child starts no parent continuation and publishes no interrupted answer', () => backgroundChildDeletion(f));
test('another live host stops a background process by durable nonce and identity without owning the conversation', { timeout: 10000 }, () => stopForeignProcess(f));
test('deleting a parent tree cancels all queues before stopping and atomically removes the tree', () => stopWholeTree(f));
test('a live executing host receives a persistent stop and finishes using its actual receipt', { timeout: 10000 }, () => liveOwnerStops(f));
test('a delete deadline preserves unfinished work and succeeds after that work releases', () => timeoutPreservesThenRetry(f));
test('an active child appearing before writer commit rejects the complete deletion atomically', () => writerDeletionAtomicRefusal(f));
test('missing dispatch identity keeps the effect live rather than proving a dead host', () => unknownDispatchIdentity(f));
test('a durable stop recovers after one terminal write failure without another user action', () => durableStopRecovery(f));
test('one global stop closes questions, approval and an in-flight MCP observation', { timeout: 10000 }, () => stopAllWaits(f));
test('only an explicit user stop closes a proven dead host effect as outcome_unknown', { timeout: 10000 }, () => userStopsDeadHost(f));
test('a live dispatch remains active until the actual receipt arrives and is never abandoned', () => liveDispatchKeepsReceipt(f));
test('a dead dispatched spawn recovers its existing child and stops without dispatching twice', { timeout: 10000 }, () => recoverDispatchedSpawn(f));
test('explicit rejection survives a stop and competing responses commit only one approval outcome', () => rejectCancelRace(f));

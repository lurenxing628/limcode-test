import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareReliableQueueOrder,
  reliableQueueEffectivePosition
} from '../src/domain/reliableQueueOrdering.ts';

function orderedIds(values) {
  return [...values].sort(compareReliableQueueOrder).map((value) => value.id);
}

test('runtime continuation created first stays ahead of later guidance', () => {
  const runtimeCreatedAt = Date.parse('2026-08-22T10:00:00.000Z');
  const guidanceCreatedAt = Date.parse('2026-08-22T10:01:00.000Z');
  assert.deepEqual(orderedIds([
    {
      id: 'guidance-later',
      createdAt: guidanceCreatedAt,
      position: (BigInt(guidanceCreatedAt) * 1_000_000n).toString()
    },
    { id: 'runtime-first', createdAt: runtimeCreatedAt }
  ]), ['runtime-first', 'guidance-later']);
});

test('ordinary initial guidance and runtime continuation share the backend timestamp position rule', () => {
  const createdAt = Date.parse('2026-08-22T10:00:00.123Z');
  assert.equal(
    reliableQueueEffectivePosition({ id: 'runtime', createdAt }),
    (BigInt(createdAt) * 1_000_000n).toString()
  );
  assert.deepEqual(orderedIds([
    { id: 'runtime-b', createdAt },
    {
      id: 'guidance-a',
      createdAt,
      position: (BigInt(createdAt) * 1_000_000n).toString()
    }
  ]), ['guidance-a', 'runtime-b']);
});

test('explicitly reordered guidance position still precedes later timestamp-derived runtime positions', () => {
  assert.deepEqual(orderedIds([
    { id: 'runtime', createdAt: Date.parse('2026-08-22T10:00:00.000Z') },
    {
      id: 'reordered-guidance',
      createdAt: Date.parse('2026-08-22T10:05:00.000Z'),
      position: '1000000'
    }
  ]), ['reordered-guidance', 'runtime']);
});

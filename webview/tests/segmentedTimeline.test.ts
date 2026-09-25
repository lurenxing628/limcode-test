import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TIMELINE_FOREGROUND_DETAIL_LIMIT,
  TIMELINE_MOUNT_LIMIT,
  TIMELINE_SEGMENT_STEP,
  absoluteTimelineFloor,
  clampTimelineSegmentStart,
  composeTimelineRows,
  latestTimelineSegmentStart,
  mountedTimelineRowCount,
  prioritizedTimelineDetailDemand
} from '../src/components/conversation/segmentedTimeline.ts';

test('60 through 10,000-floor conversations retain a constant mounted row budget', () => {
  for (const total of [60, 100, 200, 1_000, 10_000]) {
    assert.equal(mountedTimelineRowCount(total), TIMELINE_MOUNT_LIMIT);
    assert.equal(mountedTimelineRowCount(total, 100), 38);
    assert.equal(latestTimelineSegmentStart(total), total - TIMELINE_MOUNT_LIMIT);
  }
});

test('collaboration cards share the 30-row window and keep stable independent scroll anchors', () => {
  const messages = Array.from({ length: 35 }, (_, index) => ({ id: `m${index + 1}`, seq: index + 1 }));
  const cards = { afterMessage: { m35: [{ messageId: 'bound' }] }, unlocated: [{ messageId: 'waiting' }] };
  const rows = composeTimelineRows(messages, cards);
  const latest = latestTimelineSegmentStart(rows.length);
  const visible = rows.slice(latest, latest + TIMELINE_MOUNT_LIMIT);
  assert.equal(visible.length, TIMELINE_MOUNT_LIMIT);
  assert.deepEqual(visible.slice(-3).map((row) => row.id), ['m35', 'collaboration:bound', 'collaboration:waiting']);
  assert.equal(visible.filter((row) => row.kind === 'message').length, 28);
  assert.deepEqual(prioritizedTimelineDetailDemand(visible.flatMap((row) => row.kind === 'message' ? [row.id] : [])).critical,
    ['m35'], 'the newest visible Message gets detail priority, not a collaboration card');
  const anchor = visible[0].id;
  const olderStart = clampTimelineSegmentStart(rows.length, latest - TIMELINE_SEGMENT_STEP);
  assert.ok(rows.slice(olderStart, olderStart + TIMELINE_MOUNT_LIMIT).some((row) => row.id === anchor));
  const restored = clampTimelineSegmentStart(rows.length, olderStart + TIMELINE_SEGMENT_STEP);
  assert.ok(rows.slice(restored, restored + TIMELINE_MOUNT_LIMIT).some((row) => row.id === anchor));
  const prepend = composeTimelineRows([{ id: 'past-1' }, { id: 'past-2' }, ...messages], cards);
  const anchorIndex = prepend.findIndex((row) => row.id === anchor);
  const historyStart = clampTimelineSegmentStart(prepend.length, anchorIndex - TIMELINE_SEGMENT_STEP);
  assert.ok(prepend.slice(historyStart, historyStart + TIMELINE_MOUNT_LIMIT).some((row) => row.id === anchor),
    'history prepend can restore either Message or collaboration row by its stable key');
  assert.equal(absoluteTimelineFloor(messages[34].seq, 1), 35, 'collaboration never increases Message floor');
});

test('a Conversation with no Messages pages through only collaboration rows at constant DOM cost', () => {
  const rows = composeTimelineRows([], {
    afterMessage: {}, unlocated: Array.from({ length: 70 }, (_, index) => ({ messageId: `card-${index + 1}` }))
  });
  const latest = latestTimelineSegmentStart(rows.length);
  assert.equal(latest, 40);
  assert.equal(rows.slice(latest).length, TIMELINE_MOUNT_LIMIT);
  assert.equal(rows.slice(clampTimelineSegmentStart(rows.length, latest - TIMELINE_SEGMENT_STEP),
    latest - TIMELINE_SEGMENT_STEP + TIMELINE_MOUNT_LIMIT).length, TIMELINE_MOUNT_LIMIT);
  assert.equal(rows[0].id, 'collaboration:card-1');
  assert.equal(rows.at(-1)?.id, 'collaboration:card-70');
});

test('bounded snapshots preserve absolute transcript floors after the first 200 messages', () => {
  const newestWindow = Array.from({ length: 200 }, (_, index) => 9_801 + index);
  assert.equal(absoluteTimelineFloor(newestWindow[0], 1), 9_801);
  assert.equal(absoluteTimelineFloor(newestWindow.at(-1), 200), 10_000);
  assert.equal(absoluteTimelineFloor(116.5, 89), 117, 'transient sort anchors use the next absolute floor');
  assert.equal(absoluteTimelineFloor(0, 17), 17);
  assert.throws(() => absoluteTimelineFloor(0, 0), /positive integer/);
});

test('timeline detail demand always admits the last row first and backgrounds the old prefix', () => {
  const ids = Array.from({ length: TIMELINE_MOUNT_LIMIT }, (_, index) => `message-${index + 1}`);
  const demand = prioritizedTimelineDetailDemand(ids);
  assert.deepEqual(demand.critical, ['message-30']);
  assert.deepEqual(demand.visible, ['message-29', 'message-28', 'message-27', 'message-26', 'message-25', 'message-24', 'message-23']);
  assert.equal(demand.visible.length + demand.critical.length, TIMELINE_FOREGROUND_DETAIL_LIMIT);
  assert.deepEqual(demand.background, Array.from({ length: 22 }, (_, index) => `message-${22 - index}`));
  assert.deepEqual(prioritizedTimelineDetailDemand([]), { critical: [], visible: [], background: [] });
});

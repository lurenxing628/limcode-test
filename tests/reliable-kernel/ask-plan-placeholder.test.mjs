import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAskUserToolRequest } from '../../dist/extension/shared/askUser.js';
import { normalizeSubmitPlanToolRequest } from '../../dist/extension/shared/planReview.js';

test('ask optional boolean and description tolerate empty placeholders without altering the original question', () => {
  for (const empty of [undefined, null, '', '   ', [], {}]) {
    const args = { question: 'Choose', options: [{ label: 'One', description: empty }], multiple: empty };
    const original = structuredClone(args);
    assert.deepEqual(normalizeAskUserToolRequest(args), { question: 'Choose', options: [{ label: 'One' }], multiple: false });
    assert.deepEqual(args, original);
  }
  for (const multiple of [false, true]) {
    assert.equal(normalizeAskUserToolRequest({ question: 'Choose', options: [{ label: 'One' }], multiple }).multiple, multiple);
  }
  for (const multiple of [0, 1, 'false', 'true', [false], { enabled: false }]) {
    assert.throws(() => normalizeAskUserToolRequest({ question: 'Choose', options: [{ label: 'One' }], multiple }), /multiple must be a boolean/);
  }
  for (const description of [0, false, true, [false], { text: 'real data' }]) {
    assert.throws(() => normalizeAskUserToolRequest({ question: 'Choose', options: [{ label: 'One', description }] }), /description must be a string/);
  }
});

test('submit_plan infers its only rewrite mode while retaining update and malformed-mode errors', () => {
  for (const mode of [undefined, null, '', '   ']) {
    const args = { plan: 'Inspect then fix', taskList: { mode, items: [{ title: 'Inspect' }] } };
    const original = structuredClone(args);
    const request = normalizeSubmitPlanToolRequest(args);
    assert.equal(request.taskList.mode, 'rewrite');
    assert.deepEqual(request.taskList.items, [{ title: 'Inspect' }]);
    assert.deepEqual(args, original);
  }
  assert.equal(normalizeSubmitPlanToolRequest({ plan: 'Inspect', taskList: { items: [{ title: 'Inspect' }] } }).taskList.mode, 'rewrite');
  assert.throws(() => normalizeSubmitPlanToolRequest({
    plan: 'Inspect', taskList: { mode: 'update', items: [{ title: 'Inspect' }] }
  }), /must use mode="rewrite"/);
  for (const mode of [false, 0, 'unknown', {}, []]) {
    assert.throws(() => normalizeSubmitPlanToolRequest({ plan: 'Inspect', taskList: { mode, items: [{ title: 'Inspect' }] } }), /taskList/);
  }
  assert.throws(() => normalizeSubmitPlanToolRequest({ plan: 'Inspect' }), /taskList is required/);
  assert.throws(() => normalizeSubmitPlanToolRequest({ plan: 'Inspect', taskList: { items: [] } }), /at least one task/);
});

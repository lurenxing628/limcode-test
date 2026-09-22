import assert from 'node:assert/strict';
import test from 'node:test';

const { childThinkingOverrideForSpawn, childThinkingInheritanceFromAuthority } = await import('../../dist/extension/backend/reliableKernel/childThinkingInheritance.js');

test('child thinking override is explicit opt-in', () => {
  const current = { kind: 'openai-effort', value: 'high' };
  assert.deepEqual(childThinkingOverrideForSpawn({ inheritThinking: true, thinkingOverride: current }), current);
  assert.equal(childThinkingOverrideForSpawn({ inheritThinking: false, thinkingOverride: current }), undefined);
});

for (const tokens of [0, -1]) test(`child inheritance keeps the valid Gemini budget ${tokens}`, () => {
  const override = { kind: 'gemini-budget', tokens };
  const inherited = childThinkingInheritanceFromAuthority({ model: {
    inheritThinkingToChildren: true, thinkingOverride: override
  } });
  assert.deepEqual(childThinkingOverrideForSpawn(inherited), override);
});

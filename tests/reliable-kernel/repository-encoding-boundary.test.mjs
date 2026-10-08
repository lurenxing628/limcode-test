import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { DOMAIN_REPOSITORIES } = require(path.join(compiled, 'backend/reliableKernel/repositories.js'));

test('Repository 构造不序列化 JSON，SQL 编码仍验证正文并只序列化一次', () => {
  const repository = DOMAIN_REPOSITORIES.domain('ModelRequest');
  const stringify = JSON.stringify;
  let serializations = 0;
  JSON.stringify = (...args) => { serializations += 1; return stringify(...args); };
  try {
    const input = { inputTokens: 7, detail: { cached: 2 } };
    const mutation = repository.update('request', { usage_json: input });
    input.detail.cached = 9;
    assert.equal(serializations, 0);
    assert.deepEqual(mutation.patch.usage_json, { inputTokens: 7, detail: { cached: 2 } });
    const encoded = repository.codec.encodePatch(mutation.patch);
    assert.equal(serializations, 1);
    assert.equal(encoded.usage_json, '{"inputTokens":7,"detail":{"cached":2}}');
  } finally { JSON.stringify = stringify; }

  assert.throws(() => repository.update('request', { arbitrary: 1 }), /immutable|unknown/);
  assert.throws(() => repository.update('request', { updated_at: null }), /cannot be null/);
  const invalidJson = repository.update('request', { usage_json: '{invalid' });
  assert.throws(() => repository.codec.encodePatch(invalidJson.patch), SyntaxError);
});

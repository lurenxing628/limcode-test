import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNativeCompactContentsMultimodal } from '../../dist/extension/backend/capabilities/llmRequestContentPreparation.js';

const MIB = 1024 * 1024;

test('Native Compact validates multi-megabyte canonical media without RegExp stack overflow', async () => {
  const bytes = Buffer.alloc(4 * MIB, 0x31);
  const contents = [{
    role: 'user',
    parts: [{
      inlineData: {
        mimeType: 'image/png',
        name: 'large.png',
        data: bytes.toString('base64'),
        sizeBytes: bytes.byteLength
      }
    }]
  }];

  const prepared = await prepareNativeCompactContentsMultimodal(contents, {
    settings: undefined
  });
  assert.equal(prepared[0].parts[0].inlineData.data, contents[0].parts[0].inlineData.data);
  assert.equal(prepared[0].parts[0].inlineData.sizeBytes, bytes.byteLength);
});

test('Native Compact resolves and validates one repeated managed attachment only once per request', async (t) => {
  const reference = {
    inlineData: {
      attachmentId: 'attachment-native-repeat',
      mimeType: 'image/png',
      name: 'repeat.png',
      sizeBytes: 1,
      sha256: 'b'.repeat(64)
    }
  };
  let resolveCalls = 0;
  const from = Buffer.from;
  let decodes = 0;
  Buffer.from = function (value, ...args) {
    if (value === 'Zg==' && args[0] === 'base64') decodes += 1;
    return from.call(this, value, ...args);
  };
  t.after(() => { Buffer.from = from; });
  const prepared = await prepareNativeCompactContentsMultimodal([
    { role: 'user', parts: [structuredClone(reference)] },
    { role: 'user', parts: [structuredClone(reference)] }
  ], {
    settings: undefined,
    async resolveAttachment(input) {
      resolveCalls += 1;
      assert.equal(input.attachmentId, 'attachment-native-repeat');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { inlineData: { ...reference.inlineData, data: 'Zg==' } };
    }
  });

  assert.equal(resolveCalls, 1);
  assert.equal(decodes, 1);
  assert.equal(prepared[0].parts[0].inlineData.data, 'Zg==');
  assert.equal(prepared[1].parts[0].inlineData.data, 'Zg==');
  assert.notEqual(prepared[0].parts[0].inlineData, prepared[1].parts[0].inlineData);

  await assert.rejects(
    prepareNativeCompactContentsMultimodal([
      { role: 'user', parts: [structuredClone(reference)] },
      { role: 'user', parts: [{ inlineData: { ...reference.inlineData, name: 'drift.png' } }] }
    ], {
      settings: undefined,
      async resolveAttachment() {
        return { inlineData: { ...reference.inlineData, data: 'Zg==' } };
      }
    }),
    /metadata conflicts/
  );
});

test('Native Compact still rejects noncanonical media and declared-size mismatches', async () => {
  await assert.rejects(
    prepareNativeCompactContentsMultimodal([{
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', name: 'bad.png', data: 'Zh==' } }]
    }], { settings: undefined }),
    (error) => error?.name === 'LlmNativeCompactMediaError' && /not canonical base64/.test(error.message)
  );

  await assert.rejects(
    prepareNativeCompactContentsMultimodal([{
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', name: 'wrong-size.png', data: 'Zg==', sizeBytes: 2 } }]
    }], { settings: undefined }),
    (error) => error?.name === 'LlmNativeCompactMediaError' && /declared 2 bytes but resolved 1/.test(error.message)
  );
});

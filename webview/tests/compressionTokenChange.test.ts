import assert from 'node:assert/strict';
import test from 'node:test';
import { compressionTokenChange } from '../src/components/conversation/compressionTokenChange.ts';

test('节省量只按压缩前后的上下文计算，缩小和变大都如实给出', () => {
  assert.equal(compressionTokenChange({ contextTokensBefore: 9_062, estimatedTokensAfter: 3_166 }), 5_896);
  assert.equal(compressionTokenChange({ contextTokensBefore: 3_000, estimatedTokensAfter: 4_200 }), -1_200);
});

test('旧记录没有压缩前上下文时不显示节省量，不拿完整请求（含系统提示词和工具定义）去减', () => {
  assert.equal(compressionTokenChange({ estimatedTokensAfter: 3_166 }), undefined);
  assert.equal(compressionTokenChange({ contextTokensBefore: 9_062 }), undefined);
});

test('压缩后估算没有计入服务商密文摘要时不显示节省量', () => {
  assert.equal(compressionTokenChange({
    contextTokensBefore: 9_062, estimatedTokensAfter: 1_200, resultSizeUncounted: true
  }), undefined);
});

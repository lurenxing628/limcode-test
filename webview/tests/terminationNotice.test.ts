import assert from 'node:assert/strict';
import test from 'node:test';
import { terminationNotice } from '../src/components/conversation/terminationNotice.ts';

const quotaDetail = 'Provider 额度已用完，自动重试不会成功（原文：Sorry, if we executed this query (up to 4096 tokens), you would be above your monthly token limit (202422 out of 200000), please contact us to get it increased or become an Ask Sage member now）。'
  + '提高额度或换一个渠道/模型后，直接发送“继续”即可接着做，已完成的工具结果还在上下文里。';

test('原因里已说明工具结果还在时，工具调用之后的失败提示不再重复“工具结果已保留”', () => {
  const notice = terminationNotice({ kind: 'failed', reasonCode: 'llm_request_failed', detail: quotaDetail }, true);
  assert.equal(notice, `本轮在工具调用后未正常完成：${quotaDetail}`);
  assert.equal(notice.match(/工具结果/g)?.length, 1);
});

test('只提到工具结果、没说保留的原因照常补上“工具结果已保留”', () => {
  assert.equal(
    terminationNotice({ kind: 'failed', reasonCode: 'llm_request_failed', detail: '工具结果超过了模型的上下文上限。' }, true),
    '本轮在工具调用后未正常完成：工具结果超过了模型的上下文上限。工具结果已保留。'
  );
});

test('其余提示与原来一致', () => {
  assert.equal(
    terminationNotice({ kind: 'failed', reasonCode: 'llm_request_failed', detail: 'HTTP 500' }, true),
    '本轮在工具调用后未正常完成：HTTP 500。工具结果已保留。'
  );
  assert.equal(
    terminationNotice({ kind: 'failed', reasonCode: 'llm_request_failed', detail: quotaDetail }, false),
    `本次回复未正常完成：${quotaDetail.replace(/。$/, '')}`
  );
  assert.match(terminationNotice({ kind: 'failed', reasonCode: 'empty_model_result' }, true), /工具结果仍会保留/);
  assert.match(terminationNotice({ kind: 'failed', reasonCode: 'llm_request_failed' }, false), /^本次回复未正常完成。/);
  assert.match(terminationNotice({ kind: 'cancelled', reasonCode: 'user_cancelled' }, false), /^本次回复已终止。/);
  assert.match(terminationNotice({ kind: 'cancelled', reasonCode: 'user_cancelled' }, true), /^本轮在工具调用后被终止/);
});

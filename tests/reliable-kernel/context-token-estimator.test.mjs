import assert from 'node:assert/strict';
import test from 'node:test';
import * as kernel from '../../dist/extension/backend/reliableKernel/index.js';

const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const TOOL_PAIR_TYPE = 'application/vnd.limcode.context-tool-pair+json';
const COMPRESSION_TYPE = 'application/vnd.limcode.compression-contents+json';

function segment(segmentKind, contentType, content, messageRole = null) {
  return {
    segmentKind,
    messageRole,
    contentObject: { content_type: contentType },
    content: Buffer.from(content, 'utf8')
  };
}

function emptyBreakdown(overrides = {}) {
  const value = {
    systemTokens: 0,
    toolSchemaTokens: 0,
    providerFramingTokens: 0,
    contextTokens: 0,
    currentInputTokens: 0,
    runtimeDeliveryTokens: 0,
    turnReminderTokens: 0,
    mediaTokens: 0,
    fixedTokens: 0,
    bodyTokens: 0,
    fullTokens: 0,
    ...overrides
  };
  value.fullTokens = value.fixedTokens + value.bodyTokens;
  return value;
}


test('provider语义估算不会把base64图片字符当普通文本token', () => {
  const first = 'A'.repeat(339_032);
  const second = 'B'.repeat(392_052);
  const message = {
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'image/png', data: first } },
      { inlineData: { mimeType: 'image/png', data: second } }
    ]
  };
  const serialized = JSON.stringify(message);
  const estimated = kernel.estimateContextSegmentTokens(
    segment('message', MESSAGE_TYPE, serialized, 'user')
  );
  assert.ok(Buffer.byteLength(serialized) / 4 > 180_000, 'legacy byte estimate must reproduce the false 100k+ spike');
  assert.ok(estimated > 0 && estimated < 2_000, `multimodal estimate should stay bounded, got ${estimated}`);
});

test('普通模型窗口只保留同一托管附件的首次正文并在工具响应内保留F引用', () => {
  const attachment = {
    attachmentId: 'attachment-repeat-media',
    mimeType: 'image/png',
    name: 'repeat.png',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    data: 'Zg=='
  };
  const inlinePart = () => ({ inlineData: { ...attachment } });
  const contents = [
    { role: 'user', parts: [inlinePart()] },
    { role: 'model', parts: [{ id: 'call-repeat', functionCall: { name: 'read', args: {} } }] },
    {
      role: 'user',
      parts: [{
        id: 'call-repeat',
        functionResponse: {
          name: 'read',
          response: { ok: true },
          parts: [inlinePart()]
        }
      }]
    },
    { role: 'user', parts: [inlinePart()] }
  ];
  const handles = {
    entries: [{
      kind: 'attachment',
      ref: 'F7',
      target: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes
    }]
  };

  const projected = kernel.projectOrdinaryModelWindow(contents, handles);
  assert.equal(projected.uniqueManagedMediaBodyCount, 1);
  assert.equal(projected.suppressedManagedMediaBodyCount, 2);
  assert.equal(projected.contents.flatMap((content) => content.parts)
    .filter((part) => 'inlineData' in part).length, 1);
  const response = projected.contents[2].parts[0].functionResponse;
  assert.equal(response.parts, undefined);
  assert.deepEqual(response.response.repeatedManagedMedia.map((entry) => entry.attachmentRef), ['F7']);
  const repeatedText = projected.contents[3].parts[0].text;
  assert.match(repeatedText, /repeated_managed_media_body_omitted/);
  assert.match(repeatedText, /F7/);
  assert.doesNotMatch(repeatedText, /attachment-repeat-media|sha256|data/);
  assert.throws(
    () => kernel.projectOrdinaryModelWindow([
      { role: 'user', parts: [inlinePart()] },
      { role: 'user', parts: [{ inlineData: { ...attachment, name: 'drift.png' } }] }
    ], handles),
    /metadata changed/
  );
});

test('provider compaction ciphertext只保留rawItem权威副本且不按密文字符收费', () => {
  const ciphertext = 'cipher'.repeat(20_000);
  const contents = [{
    role: 'model',
    parts: [{
      providerContext: {
        provider: 'openai',
        format: 'openai-responses',
        itemType: 'compaction',
        encryptedContent: ciphertext,
        rawItem: { type: 'compaction', encrypted_content: ciphertext }
      }
    }]
  }];
  const canonical = kernel.canonicalizeCompressionContents(contents);
  assert.equal(canonical[0].parts[0].providerContext.encryptedContent, undefined);
  assert.equal(canonical[0].parts[0].providerContext.rawItem.encrypted_content, ciphertext);
  assert.ok(kernel.estimateMessageContentsTokens(contents) < 20);
});

test('Claude 原生压缩块的可读摘要按文本计入上下文；旧库里只记了外壳大小的压缩块也按内容计', () => {
  const summaryText = '已读取 README.md，第 1 行 hello，派过 A1 和 A2 两个子 Agent。'.repeat(60);
  const contents = [{
    role: 'model',
    parts: [{
      providerContext: {
        provider: 'anthropic',
        format: 'claude',
        itemType: 'compaction',
        rawItem: { type: 'compaction', content: summaryText, signature: 'signed-compaction' }
      }
    }]
  }];
  const measured = kernel.estimateMessageContentsTokens(contents);
  assert.ok(measured >= kernel.estimateTextTokens(summaryText), `compaction text must be counted, got ${measured}`);
  // Blocks written before this fix stored estimatedTokens of the envelope overhead only (4 in a real run).
  const envelope = JSON.stringify({ kind: 'compression_contents', version: 1, contents, methodKind: 'provider_native', estimatedTokens: 4 });
  const compression = segment('compression', COMPRESSION_TYPE, envelope, 'model');
  assert.equal(kernel.estimateContextSegmentTokens(compression), measured);
  const question = segment('message', MESSAGE_TYPE, JSON.stringify({ role: 'user', parts: [{ text: '还记得吗？' }] }), 'user');
  const total = kernel.estimateMaterializedContextTokens([compression, question]);
  assert.ok(total >= measured, `Context estimate ${total} must include the ${measured}-token compaction summary`);
  // A larger stored estimate (e.g. rendered attachment state) is still honoured.
  const richer = segment('compression', COMPRESSION_TYPE, JSON.stringify({
    kind: 'compression_contents', version: 1, contents, methodKind: 'provider_native', estimatedTokens: measured + 500
  }), 'model');
  assert.equal(kernel.estimateContextSegmentTokens(richer), measured + 500);
  assert.equal(kernel.estimateMaterializedContextTokens([richer, question]) - total, 500);
});

test('OpenAI 原生压缩的密文按服务商输出计入上下文；旧库里记成 0 的压缩块也按输出纠正', () => {
  const opaque = [{
    role: 'model',
    parts: [{
      providerContext: {
        provider: 'openai',
        format: 'openai-responses',
        itemType: 'compaction',
        rawItem: { type: 'compaction', encrypted_content: 'cipher'.repeat(2_000) }
      }
    }]
  }];
  const observation = { role: 'user', parts: [{ text: '附件观察：截图里是登录页，按钮文字为“继续”。' }] };
  assert.ok(kernel.estimateMessageContentsTokens(opaque) < 20, 'ciphertext itself is never charged by characters');
  // New results: the readable part (e.g. Attachment observation state) plus the compaction output.
  const measured = kernel.estimateMessageContentsTokens([...opaque, observation]);
  assert.equal(kernel.estimateCompressionResultTokens([...opaque, observation], 2_845, 1.25), measured + Math.floor(2_845 / 1.25));
  assert.equal(kernel.estimateCompressionResultTokens([...opaque, observation], undefined, 1.25), measured);
  // Readable Claude compaction text is measured, never topped up with the output count.
  const claude = [{ role: 'model', parts: [{ providerContext: { provider: 'anthropic', format: 'claude', itemType: 'compaction',
    rawItem: { type: 'compaction', content: '摘要正文', signature: 'sig' } } }] }];
  assert.equal(kernel.estimateCompressionResultTokens(claude, 1_817, 1), kernel.estimateMessageContentsTokens(claude));
  // A block written between 2026-08-21 and this fix stored estimatedTokens 0 (real run: output 2,845).
  const stored = segment('compression', COMPRESSION_TYPE, JSON.stringify({
    kind: 'compression_contents', version: 1, contents: opaque, methodKind: 'provider_native',
    estimatedTokens: 0, providerOutputTokens: 2_845, providerCalibrationRatio: 1.25
  }), 'model');
  const expected = kernel.estimateMessageContentsTokens(opaque) + Math.floor(2_845 / 1.25);
  assert.equal(kernel.estimateContextSegmentTokens(stored), expected);
  const question = segment('message', MESSAGE_TYPE, JSON.stringify({ role: 'user', parts: [{ text: '继续' }] }), 'user');
  assert.ok(kernel.estimateMaterializedContextTokens([stored, question]) >= expected);
});

test('tool_pair只估算实际重传的functionResponse，不重复计算历史工具参数', () => {
  const hugeArguments = JSON.stringify({ content: 'x'.repeat(500_000) });
  const pair = JSON.stringify({
    kind: 'tool_pair',
    toolCall: {
      id: 'call-one',
      toolName: 'read',
      argumentsContentType: 'application/json',
      arguments: hugeArguments
    },
    toolModelResult: {
      id: 'result-one',
      messageRevisionId: 'revision-one',
      resultContentType: 'application/json',
      result: JSON.stringify({ ok: true, text: 'tiny result' })
    }
  });
  const estimated = kernel.estimateContextSegmentTokens(segment('tool_pair', TOOL_PAIR_TYPE, pair));
  assert.ok(Buffer.byteLength(pair) / 4 > 100_000);
  assert.ok(estimated < 100, `tool response estimate should exclude stored arguments, got ${estimated}`);
});

test('大批搜索结果按模型投影计量，不会把约250K请求误判为452K并提前压缩', () => {
  const calls = ['advanced', 'search-a', 'search-b', 'search-c'].map((name) => ({
    id: `call-${name}`,
    functionCall: { name: `exa_${name}`, args: { query: name } }
  }));
  const segments = [
    segment('message', MESSAGE_TYPE, JSON.stringify({
      role: 'user', parts: [{ text: 'existing projected history' }]
    }), 'user'),
    segment('message', MESSAGE_TYPE, JSON.stringify({ role: 'model', parts: calls }), 'model'),
    ...calls.map((call, index) => segment('tool_pair', TOOL_PAIR_TYPE, JSON.stringify({
      kind: 'tool_pair',
      toolCall: {
        id: call.id,
        providerCallId: call.id,
        toolName: call.functionCall.name,
        argumentsContentType: 'application/json',
        arguments: JSON.stringify(call.functionCall.args)
      },
      toolModelResult: {
        id: `result-${index}`,
        resultContentType: 'application/json',
        result: JSON.stringify({ ok: true, detail: { operations: 'x'.repeat(400_000 - index * 20_000) } })
      }
    })))
  ];
  const covered = kernel.estimateMaterializedContextTokens(segments.slice(0, 2));
  const current = kernel.estimateMaterializedContextTokens(segments);
  const projectedDelta = current - covered;
  const rawToolTokens = segments.slice(2).reduce((total, item) =>
    total + kernel.estimateContextSegmentTokens(item), 0);

  assert.ok(rawToolTokens > 200_000, `fixture must reproduce the raw-result spike, got ${rawToolTokens}`);
  assert.ok(projectedDelta > 0 && projectedDelta <= kernel.TOOL_RESULT_BATCH_MAX_TOKENS + 128,
    `same-batch tool results must use the 16K model projection plus bounded envelope framing, got ${projectedDelta}`);

  const projectedFullInput = 236_285 + projectedDelta;
  const below = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 353_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 334_000,
    breakdown: emptyBreakdown({ bodyTokens: projectedFullInput })
  });
  assert.equal(below.planningInputCapacityTokens, 337_000);
  assert.ok(below.estimatedFullInputTokens < below.compressionThresholdTokens);
  assert.equal('canSend' in below, false);
  assert.equal('estimatedInputLimitTokens' in below, false);

  const reproduced = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 353_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 334_000,
    breakdown: emptyBreakdown({ fixedTokens: 17_352, bodyTokens: 314_577 })
  });
  assert.equal(reproduced.estimatedFullInputTokens, 331_929);
  assert.equal(reproduced.planningInputCapacityTokens, 337_000);
  assert.ok(260_688 < reproduced.compressionThresholdTokens,
    'Provider实测锚定的当前估算仍低于配置压缩阈值');

  const configured = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 353_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 300_000,
    breakdown: emptyBreakdown({ bodyTokens: 300_000 })
  });
  assert.ok(configured.estimatedFullInputTokens >= configured.compressionThresholdTokens);
});

test('压缩envelope使用provider输出token估算而非其持久化JSON大小', () => {
  const envelope = JSON.stringify({
    kind: 'compression_contents',
    version: 1,
    estimatedTokens: 3_320,
    contents: [{
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'A'.repeat(700_000) } }]
    }]
  });
  const estimated = kernel.estimateContextSegmentTokens(segment('compression', COMPRESSION_TYPE, envelope));
  assert.equal(estimated, 3_320);
  assert.ok(Buffer.byteLength(envelope) / 4 > 170_000);
});

test('provider usage上下文口径优先prompt/input，而不是input+output total', () => {
  const usage = { promptTokenCount: 47_100, candidatesTokenCount: 900, totalTokenCount: 48_000 };
  assert.equal(kernel.providerPromptTokens(usage), 47_100);
  assert.equal(kernel.providerTotalTokens(usage), 48_000);
  assert.equal(kernel.compressionOutputTokens(usage), 900);
});

test('压缩输出token不含推理：OpenAI把推理算进输出时减掉，Gemini另计推理时不减', () => {
  // unified 把 Responses 的 output_tokens（含 reasoning_tokens）映射成 candidatesTokenCount。
  assert.equal(kernel.compressionOutputTokens({
    promptTokenCount: 1_000, candidatesTokenCount: 900, thoughtsTokenCount: 600, totalTokenCount: 1_900
  }), 300);
  assert.equal(kernel.compressionOutputTokens({
    input_tokens: 1_000, output_tokens: 900, output_tokens_details: { reasoning_tokens: 600 }, total_tokens: 1_900
  }), 300);
  assert.equal(kernel.compressionOutputTokens({
    prompt_tokens: 1_000, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 600 }, total_tokens: 1_900
  }), 300);
  // Gemini 的 candidatesTokenCount 本来就不含思考，总数另加 thoughtsTokenCount。
  assert.equal(kernel.compressionOutputTokens({
    promptTokenCount: 1_000, candidatesTokenCount: 300, thoughtsTokenCount: 600, totalTokenCount: 1_900
  }), 300);
  // 密文压缩块按输出计入上下文，推理不回到上下文。
  const compaction = [{ role: 'model', parts: [{ providerContext: { format: 'openai-responses', itemType: 'compaction',
    rawItem: { type: 'compaction', encrypted_content: 'ciphertext' } } }] }];
  const openAIUsage = { promptTokenCount: 1_000, candidatesTokenCount: 900, thoughtsTokenCount: 600, totalTokenCount: 1_900 };
  assert.equal(
    kernel.estimateCompressionResultTokens(compaction, kernel.compressionOutputTokens(openAIUsage)),
    kernel.estimateMessageContentsTokens(compaction) + 300
  );
});

test('实用版压缩规划使用48K主体、8K摘要和16K输出且没有全局估算硬门槛', () => {
  assert.equal(kernel.MODEL_BODY_TARGET_TOKENS, 48_000);
  assert.equal(kernel.SUMMARY_TARGET_TOKENS, 8_000);
  assert.equal(kernel.DEFAULT_OUTPUT_RESERVE_TOKENS, 16_000);
  assert.equal(kernel.ESTIMATOR_SLACK_TOKENS, undefined);
  assert.equal(kernel.TOOL_RESULT_MAX_TOKENS, 4_000);
  assert.equal(kernel.TOOL_RESULT_BATCH_MAX_TOKENS, 16_000);
  assert.equal(kernel.calculateEffectiveSummaryMaxTokens(undefined, 48_000), 8_000);
  assert.equal(kernel.calculateEffectiveSummaryMaxTokens(12_000, 48_000), 8_000);
  assert.equal(kernel.calculateEffectiveSummaryMaxTokens(8_000, 3_000), 3_000);

  const projected = kernel.estimateProjectedModelInput({
    systemInstruction: 'system instruction',
    systemPromptPrefix: 'prefix',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    contextContents: [{ role: 'user', parts: [{ text: 'history' }] }],
    currentInputContents: [{ role: 'user', parts: [{ text: 'current request' }] }],
    runtimeDeliveryContents: [{ role: 'user', parts: [{ text: 'process completed' }] }],
    turnReminderContents: [{ role: 'user', parts: [{ text: 'one open task' }] }],
    providerFramingTokens: 17
  });
  const budget = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 200_000,
    providerInputLimitTokens: 100_000,
    maxOutputTokens: 2_000,
    compressionThresholdTokens: 150_000,
    breakdown: projected
  });
  assert.equal(projected.fullTokens, projected.fixedTokens + projected.bodyTokens);
  assert.equal(budget.outputReserveTokens, 16_000);
  assert.equal(budget.planningInputCapacityTokens, 100_000);
  assert.equal(budget.effectiveBodyTargetTokens, 48_000);
  assert.equal('canSend' in budget, false);
});

test('Provider实测校准把48K主体目标换算回本地估算单位再挑选保留tail', () => {
  // 真实复现：300K窗口、270K阈值、Provider实测271,656、同一请求本地估算144,419。
  const budget = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 300_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 270_000,
    breakdown: emptyBreakdown({ fixedTokens: 23_304, bodyTokens: 121_115 })
  });
  assert.equal(budget.estimatedFullInputTokens, 144_419);
  assert.equal(budget.effectiveBodyTargetTokens, 48_000);

  const calibration = kernel.providerTokenCalibration(271_656, budget.estimatedFullInputTokens);
  assert.ok(calibration.ratio > 1.88 && calibration.ratio < 1.882, `ratio=${calibration.ratio}`);

  const rooms = kernel.calculateCalibratedCompressionRooms({
    budget,
    calibration,
    irreducibleAddendaTokens: 0
  });
  assert.equal(rooms.calibratedFixedTokens, 43_836);
  assert.equal(rooms.calibratedPlanningBodyRoomTokens, 240_164);
  assert.equal(rooms.calibratedBodyTargetTokens, 48_000);

  const summaryMaxTokens = kernel.calculateEffectiveSummaryMaxTokens(undefined, rooms.calibratedBodyTargetTokens);
  assert.equal(summaryMaxTokens, 8_000);
  const tailBudgetTokens = kernel.calibratedTailBudgetTokens(rooms, summaryMaxTokens);
  assert.equal(tailBudgetTokens, 21_264);
  // 未校准时同一预算会保留40,000本地估算token，也就是约75,000个真实Provider token。
  assert.ok(
    Math.round(tailBudgetTokens * calibration.ratio) <= 48_000 - summaryMaxTokens,
    '按校准比例还原后的保留tail必须落在48K主体目标之内'
  );
});

test('配置的主体目标生效，且被阈值以下剩余空间的一半挡住避免压缩后立刻再触发', () => {
  const budget = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 300_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 270_000,
    breakdown: emptyBreakdown({ fixedTokens: 23_304, bodyTokens: 121_115 })
  });
  const calibration = kernel.providerTokenCalibration(271_656, budget.estimatedFullInputTokens);

  const lowered = kernel.calculateCalibratedCompressionRooms({
    budget,
    calibration,
    irreducibleAddendaTokens: 0,
    bodyTargetTokens: 30_000
  });
  assert.equal(lowered.calibratedBodyTargetTokens, 30_000);

  // 270,000阈值减去43,836真实固定开销后还剩226,163；配置调到120K也只能拿到其中一半。
  const raised = kernel.calculateCalibratedCompressionRooms({
    budget,
    calibration,
    irreducibleAddendaTokens: 0,
    bodyTargetTokens: 120_000
  });
  assert.equal(raised.calibratedBodyTargetTokens, 113_081);
  assert.ok(
    raised.calibratedBodyTargetTokens + raised.calibratedFixedTokens < budget.compressionThresholdTokens,
    '压缩后的真实体积必须明显低于触发阈值，否则下一回合会立刻再次压缩'
  );
});

test('没有Provider锚点时校准是恒等的，且比例只收紧不放宽', () => {
  const budget = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 300_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 270_000,
    breakdown: emptyBreakdown({ fixedTokens: 23_304, bodyTokens: 121_115 })
  });
  assert.equal(kernel.UNCALIBRATED_PROVIDER_TOKENS.ratio, 1);
  const identity = kernel.calculateCalibratedCompressionRooms({
    budget,
    calibration: kernel.UNCALIBRATED_PROVIDER_TOKENS,
    irreducibleAddendaTokens: 0
  });
  assert.equal(identity.calibratedFixedTokens, 23_304);
  assert.equal(
    kernel.calibratedTailBudgetTokens(identity, kernel.calculateEffectiveSummaryMaxTokens(undefined, 48_000)),
    40_000
  );

  // 本地估算高于Provider实测时不放宽规划：单次观测不足以支撑更大的保留上下文。
  assert.equal(kernel.providerTokenCalibration(80_000, 100_000).ratio, 1);
  // 异常锚点不得把保留tail压成零。
  assert.equal(kernel.MAX_PROVIDER_TOKEN_CALIBRATION_RATIO, 4);
  assert.equal(kernel.providerTokenCalibration(1_000_000, 10_000).ratio, 4);
  assert.equal(kernel.providerTokenCalibration(0, 10_000).ratio, 1);

  assert.equal(kernel.calibrateEstimatorToProvider(10_000, { ratio: 2 }), 20_000);
  assert.equal(kernel.calibrateProviderToEstimator(20_000, { ratio: 2 }), 10_000);
  assert.throws(() => kernel.calibrateEstimatorToProvider(10, { ratio: 0.5 }), RangeError);
  assert.throws(() => kernel.calibrateEstimatorToProvider(10, { ratio: 5 }), RangeError);
});


test('压缩请求preflight区分固定开销、完整压缩输入和fixedOverPolicy', () => {
  const fixed = kernel.preflightCompressionRequest({
    contextWindowTokens: 40_000,
    compressionThresholdTokens: 30_000,
    breakdown: emptyBreakdown({ fixedTokens: 25_000 })
  });
  assert.equal(fixed.status, 'error');
  assert.equal(fixed.code, 'fixed_overhead_infeasible');

  const body = kernel.preflightCompressionRequest({
    contextWindowTokens: 100_000,
    compressionThresholdTokens: 90_000,
    breakdown: emptyBreakdown({ fixedTokens: 1_000, bodyTokens: 84_000 })
  });
  assert.equal(body.status, 'error');
  assert.equal(body.code, 'compression_request_too_large');

  const fixedOverPolicy = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 200_000,
    compressionThresholdTokens: 40_000,
    breakdown: emptyBreakdown({ fixedTokens: 45_000, bodyTokens: 1_000 })
  });
  assert.equal(fixedOverPolicy.fixedOverPolicy, true);
  assert.equal(fixedOverPolicy.policyBodyRoomTokens, 0);
  assert.equal(fixedOverPolicy.effectiveBodyTargetTokens, 48_000);
});

test('工具调用和同批全部结果原子分组，文字tail不跳过中间大组', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'old request '.repeat(100) }] },
    {
      role: 'model',
      parts: [
        { id: 'call-a', functionCall: { name: 'read', args: { path: '/a' } } },
        { id: 'call-b', functionCall: { name: 'search', args: { query: 'needle' } } }
      ]
    },
    { role: 'user', parts: [{ id: 'call-a', functionResponse: { name: 'read', response: { text: 'a'.repeat(20_000) } } }] },
    { role: 'user', parts: [{ id: 'call-b', functionResponse: { name: 'search', response: { text: 'b'.repeat(20_000) } } }] },
    { role: 'user', parts: [{ text: 'newest request' }] }
  ];
  const groups = kernel.groupAtomicMessageContents(contents);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].kind, 'tool_exchange');
  assert.equal(groups[1].items.length, 3);
  assert.equal(groups[1].functionCallCount, 2);
  assert.equal(groups[1].functionResponseCount, 2);
  const plan = kernel.selectContinuousAtomicTail(groups, groups.at(-1).estimatedTokens);
  assert.equal(plan.tailItems.length, 1);
  assert.equal(plan.prefixGroups.at(-1).kind, 'tool_exchange');
  assert.equal(kernel.selectContinuousAtomicTail(groups, 1).protectedTailOverTarget, true);
});

test('Reliable Context信封解码后同批结果共用16K且原CAS派生对象不变', () => {
  const stored = [{
    segmentKind: 'message',
    messageRole: 'model',
    contentType: MESSAGE_TYPE,
    content: JSON.stringify({
      role: 'model',
      parts: [
        { id: 'call-a', functionCall: { name: 'read', args: { path: '/a' } } },
        { id: 'call-b', functionCall: { name: 'read', args: { path: '/b' } } }
      ]
    })
  }, ...['a', 'b'].map((name) => ({
    segmentKind: 'tool_pair',
    messageRole: null,
    contentType: TOOL_PAIR_TYPE,
    content: JSON.stringify({
      kind: 'tool_pair',
      toolCall: { id: `tool-${name}`, providerCallId: `call-${name}`, toolName: 'read' },
      toolModelResult: { id: `result-${name}`, result: JSON.stringify({ text: name.repeat(100_000) }) }
    })
  }))];
  const projectedStored = kernel.projectStoredModelFacingWindow(stored);
  assert.equal(projectedStored.contents.length, 3);
  assert.equal(projectedStored.toolResultBatches.length, 1);
  assert.ok(projectedStored.toolResultBatches[0].projectedTokens <= 16_000);

  const source = [
    { toolName: 'read', callId: 'a', resultId: 'ra', response: { path: '/a', text: 'BEGIN-A' + 'a'.repeat(80_000) + 'END-A' } },
    { toolName: 'shell', callId: 'b', resultId: 'rb', response: { processRef: 'P1', exitCode: 1, text: 'BEGIN-B' + 'b'.repeat(80_000) + 'END-B' }, priority: 'error_or_receipt', reread: { kind: 'process_output', processRef: 'P1' } },
    { toolName: 'tiny', callId: 'c', resultId: 'rc', response: { ok: true, value: 7 } }
  ];
  const before = structuredClone(source);
  const first = kernel.projectToolResultBatch(source);
  assert.deepEqual(source, before);
  assert.deepEqual(first, kernel.projectToolResultBatch(source));
  assert.equal(first.items.length, source.length);
  assert.equal(first.items[2].truncated, false);
  assert.deepEqual(first.items[2].response, source[2].response);
  assert.ok(first.projectedTokens <= 16_000);
  assert.equal(first.items[1].response.processRef, 'P1');
  assert.equal(first.items[1].response.rereadHint.processRef, 'P1');
  assert.match(first.items[1].response.preview, /BEGIN-B/);
  assert.match(first.items[1].response.preview, /END-B/);
});

test('water-fill使用priority且必要骨架软超时不丢配对身份', () => {
  const response = { text: 'same-long-evidence-'.repeat(20_000) };
  const priority = kernel.projectToolResultBatch([
    { toolName: 'search', callId: 'ordinary', response, priority: 'ordinary' },
    { toolName: 'shell', callId: 'failure', response, priority: 'error_or_receipt' }
  ], { perResultTokens: 4_000, batchTokens: 2_000 });
  assert.ok(priority.items[1].allocatedTokens > priority.items[0].allocatedTokens);
  assert.ok(priority.items[1].projectedTokens > priority.items[0].projectedTokens);

  const shortFirst = kernel.projectToolResultBatch([
    { toolName: 'short', callId: 'short', response: { text: 'small-result-'.repeat(30) } },
    { toolName: 'long-a', callId: 'long-a', response },
    { toolName: 'long-b', callId: 'long-b', response }
  ], { perResultTokens: 1_000, batchTokens: 1_000 });
  assert.equal(shortFirst.items[0].truncated, false, 'naturally short result must be satisfied before long previews');

  const source = Array.from({ length: 12 }, (_, index) => ({
    toolName: 'tool',
    callId: `call-${index}-${'x'.repeat(80)}`,
    resultId: `result-${index}`,
    response: { status: 'completed', text: 'z'.repeat(10_000) }
  }));
  const skeletons = kernel.projectToolResultBatch(source, { perResultTokens: 100, batchTokens: 100 });
  assert.equal(skeletons.mandatoryBatchOverTarget, true);
  assert.deepEqual(skeletons.items.map((item) => item.resultId), source.map((item) => item.resultId));
});

test('摘要投影保留首份托管媒体正文并把长工具参数改为digest描述', () => {
  const raw = Buffer.from('SECRET-MEDIA-CONTENT'.repeat(2_000));
  const base64 = raw.toString('base64');
  const projected = kernel.projectSummaryModelWindow([
    { role: 'model', parts: [{ id: 'call-write', functionCall: { name: 'write', args: { path: '/tmp/a', content: 'x'.repeat(80_000) } } }] },
    { role: 'user', parts: [{
      id: 'call-write',
      functionResponse: {
        name: 'write',
        response: { ok: true },
        parts: [{ inlineData: {
          mimeType: 'image/png',
          name: 'evidence.png',
          data: base64,
          attachmentId: 'attachment-evidence',
          sha256: 'a'.repeat(64),
          sizeBytes: raw.byteLength,
          storage: 'managed'
        } }]
      }
    }] }
  ], {
    entries: [{
      kind: 'attachment', ref: 'F1', target: 'attachment-evidence',
      name: 'evidence.png', mimeType: 'image/png', sizeBytes: raw.byteLength
    }]
  });
  const encoded = JSON.stringify(projected.contents);
  assert.equal(encoded.includes(base64), true);
  assert.ok(projected.mediaTokens > 0);
  assert.equal(projected.uniqueManagedMediaBodyCount, 1);
  assert.equal(projected.contents.some((content) => content.parts.some((part) => 'functionCall' in part)), false);
  assert.equal(projected.contents.some((content) => content.parts.some((part) => 'inlineData' in part)), true);
  assert.match(encoded, /sha256/);
  assert.doesNotMatch(encoded, /historical_media/);
});

test('native compact使用完整窗口且拒绝未固化sourcePath媒体', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'first' }] },
    { role: 'model', parts: [{ text: 'second' }] },
    { role: 'user', parts: [{ text: 'third' }] }
  ];
  const ready = kernel.planNativeCompactWindow({ contents, inputCapacityTokens: 100_000 });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.contents.length, contents.length);
  assert.equal(ready.retainedLocalTailCount, 0);
  const oversized = kernel.planNativeCompactWindow({
    contents: [{ role: 'user', parts: [{ text: 'large '.repeat(10_000) }] }],
    inputCapacityTokens: 10
  });
  assert.equal(oversized.status, 'error');
  assert.equal(oversized.code, 'compression_request_too_large');
  const unresolved = kernel.planNativeCompactWindow({
    contents: [{ role: 'user', parts: [{ inlineData: {
      mimeType: 'image/png', sourcePath: '/tmp/not-admitted.png', sizeBytes: 123
    } }] }],
    inputCapacityTokens: 100_000
  });
  assert.equal(unresolved.status, 'error');
  assert.equal(unresolved.code, 'media_size_unknown');
  const managed = kernel.planNativeCompactWindow({
    contents: [{ role: 'user', parts: [{ inlineData: {
      mimeType: 'image/png', attachmentId: 'attachment-one', sizeBytes: 123,
      sha256: 'a'.repeat(64), storage: 'managed'
    } }] }],
    inputCapacityTokens: 100_000
  });
  assert.equal(managed.status, 'ready');
});

test('stored runtime_context规划与Adapter共用typed envelope和4K渲染', () => {
  const projectedDelivery = kernel.projectRuntimeDeliveryForModel({
    kind: 'child_answer',
    status: 'submitted',
    phase: 'current_turn',
    deliveryId: 'delivery-planner-runtime',
    inboxItemId: 'inbox-planner-runtime',
    targetTurnId: 'turn-parent-planner-runtime',
    deliveredAt: '2026-08-09T12:00:00.000Z',
    childExecutionId: 'child-planner-runtime',
    answerBridgeId: 'bridge-planner-runtime',
    submissionId: 'submission-planner-runtime',
    sourceTurnId: 'turn-child-planner-runtime',
    title: 'large child result',
    contentType: 'text/plain',
    content: `HEAD-${'x'.repeat(1_000_000)}-TAIL`
  });
  assert.ok(projectedDelivery);
  assert.ok(kernel.estimateTextTokens(projectedDelivery.content) > 100_000);
  const stored = {
    segmentKind: 'runtime_context',
    messageRole: null,
    contentType: projectedDelivery.contentType,
    content: projectedDelivery.content
  };
  const planned = kernel.projectStoredModelFacingWindow([stored]);
  const fullRequest = {
    kind: 'full-model-request',
    modelRequestId: 'runtime-planner-request',
    conversationId: 'runtime-planner-conversation',
    attemptSeq: '1',
    socketGeneration: '1',
    providerId: 'runtime-planner-provider',
    modelId: 'runtime-planner-model',
    authoritySnapshot: {
      model: {
        providerConfigId: 'runtime-planner-provider',
        provider: 'openai-compatible',
        modelId: 'runtime-planner-model'
      },
      toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} },
      systemPrompt: { text: '' }
    },
    recipe: {
      kind: 'reliable-agent-turn',
      tools: [],
      modelHandleCatalog: {
        entries: [{ kind: 'child', ref: 'A1', target: 'bridge-planner-runtime' }]
      }
    },
    context: [{ segmentId: 'runtime-planner-segment', ...stored }],
    attachmentCatalogState: { catalog: [], placements: [] }
  };
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('runtime-planner-provider', {});
  const sent = adapter.estimateFullRequestInput(fullRequest);
  assert.equal(planned.tokenCount, sent.contextTokens);
  assert.ok(planned.tokenCount <= kernel.RUNTIME_DELIVERY_MODEL_MAX_TOKENS + 4);
  assert.match(planned.contents[0].parts[0].text, /truncated runtime result/);
  assert.match(planned.contents[0].parts[0].text, /HEAD-/);
  assert.match(planned.contents[0].parts[0].text, /-TAIL/);
});

test('stored runtime_context hard-cut旧裸文本而不按普通user消息估算', () => {
  assert.throws(
    () => kernel.projectStoredModelFacingWindow([{
      segmentKind: 'runtime_context',
      messageRole: null,
      contentType: 'text/plain',
      content: 'legacy naked runtime result'
    }]),
    /must use application\/vnd\.limcode\.runtime-delivery-model\+json/
  );
});



test('当前扩展替换命令等待process真实终态，其他命令保持请求等待期', () => {
  const selfUpdate = [
    'code --uninstall-extension your-publisher.limcode-test',
    'code --install-extension ./limcode-test-0.0.17.vsix'
  ].join(' && ');

  assert.equal(kernel.effectiveProcessForegroundWaitMs(selfUpdate, 1_000, 120_000), 120_000);
  assert.equal(kernel.effectiveProcessForegroundWaitMs(selfUpdate, 60_000, 5_000), 60_000);
  assert.equal(
    kernel.effectiveProcessForegroundWaitMs(
      'code --uninstall-extension publisher.other && code --install-extension ./other.vsix',
      1_000,
      120_000
    ),
    1_000
  );
  assert.equal(
    kernel.effectiveProcessForegroundWaitMs(
      'code --install-extension ./limcode-test-0.0.17.vsix',
      1_000,
      120_000
    ),
    1_000
  );
});

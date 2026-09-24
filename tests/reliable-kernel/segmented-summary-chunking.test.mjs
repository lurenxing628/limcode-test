import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  createLlmProviderCapability,
  dryRunCompactLlmProvider
} from '../../dist/extension/backend/capabilities/llmProvider.js';

const PROVIDERS = [
  ['openai-compatible', 'https://example.test/v1'],
  ['openai-responses', 'https://example.test/v1'],
  ['claude', 'https://api.anthropic.com/v1'],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta']
];

function providerConfig(provider, baseUrl) {
  return {
    id: `summary-${provider}`,
    name: `Summary ${provider}`,
    provider,
    baseUrl,
    model: provider === 'claude' ? 'claude-sonnet-test' : provider === 'gemini' ? 'gemini-test' : 'gpt-test',
    models: [],
    apiKey: 'offline-placeholder-key',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    contextWindowTokens: 65_536,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function compactRequest(provider) {
  const methodConfigSnapshot = {
    id: `segmented-${provider}`,
    name: `Segmented ${provider}`,
    kind: 'segmented_summary',
    trigger: { mode: 'manual' },
    llmSummary: {
      targetTokens: 1_000,
      generationConfig: { maxOutputTokens: 2_048 }
    },
    createdAt: 1,
    updatedAt: 1
  };
  const largeText = `TEXT-START-${'ordinary-history '.repeat(28_000)}-TEXT-END`;
  const oversizedToolResult = `TOOL-START-${'tool-output '.repeat(60_000)}-TOOL-END`;
  return {
    request: {
      id: `oversized-${provider}`,
      blockId: `block-${provider}`,
      conversationId: `conversation-${provider}`,
      methodKind: 'segmented_summary',
      methodConfigSnapshot,
      contents: [],
      segments: [[
        { role: 'user', parts: [{ text: largeText }] },
        {
          role: 'model',
          parts: [{ id: 'call-oversized', functionCall: { name: 'read', args: { path: '/fixture' } } }]
        },
        {
          role: 'user',
          parts: [{
            id: 'call-oversized',
            functionResponse: { name: 'read', response: { text: oversizedToolResult } }
          }]
        }
      ]],
      sourceHash: `source-${provider}`
    },
    largeText,
    oversizedToolResult
  };
}

function observationCompactRequest(kind = 'llm_summary', cachedObservation) {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XkW5WQAAAABJRU5ErkJggg==', 'base64');
  const attachmentRef = 'F1';
  const requirement = {
    attachmentRef,
    attachmentId: 'attachment-visual-evidence',
    name: 'visual-evidence.png',
    mimeType: 'image/png',
    sizeBytes: bytes.byteLength,
    ...(cachedObservation ? { cachedObservation } : {})
  };
  return {
    bytes,
    request: {
      id: `observation-${kind}-${cachedObservation ? 'cached' : 'fresh'}`,
      blockId: `observation-block-${kind}-${cachedObservation ? 'cached' : 'fresh'}`,
      conversationId: 'conversation-observation',
      methodKind: kind,
      methodConfigSnapshot: {
        id: `observation-config-${kind}`,
        name: `Observation ${kind}`,
        kind,
        trigger: { mode: 'manual' },
        llmSummary: { targetTokens: 1_000, generationConfig: { maxOutputTokens: 2_048 } },
        createdAt: 1,
        updatedAt: 1
      },
      contents: [{ role: 'user', parts: [
        { text: 'Preserve the actual visual evidence during compression.' },
        { inlineData: {
          mimeType: requirement.mimeType,
          name: requirement.name,
          attachmentId: requirement.attachmentId,
          sha256: 'a'.repeat(64),
          sizeBytes: requirement.sizeBytes,
          storage: 'managed'
        } }
      ] }],
      sourceHash: 'source-observation',
      attachmentObservationProfileSha256: 'b'.repeat(64),
      attachmentObservationRequirements: [requirement]
    }
  };
}

function waitForCompactTerminal(capability, request, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('compact observation test timed out')), timeoutMs);
    capability.compact(request, (event) => {
      if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

test('segmented summary preserves overflow text across leaf chunks and hierarchy merge requests', async () => {
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.segments = [[{
    role: 'user',
    parts: [{ text: `OVERFLOW-START-${'overflow-history '.repeat(12_000)}-OVERFLOW-END` }]
  }]];
  const result = await dryRunCompactLlmProvider(fixture.request, {
    settings: async () => ({
      ...providerConfig(provider, 'https://example.test/v1'),
      contextWindowTokens: 30_000
    }),
    compressionSettings: async () => undefined
  });
  assert.equal(result.kind, 'provider_requests');
  assert.ok(result.calls.length >= 2);
  assert.match(result.note, /leaf summary requests/);
  assert.equal(result.calls.some((call) => call.label === 'Summary replacement merge'), false);
  const wire = result.calls.map((call) => call.bodyText).join('\n');
  assert.match(wire, /OVERFLOW-START/);
  assert.match(wire, /OVERFLOW-END/);
  assert.doesNotMatch(wire, /hierarchical compression fallback/);
});

test('segmented summary executes leaf requests before a runtime hierarchy merge', async () => {
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.segments = [[{
    role: 'user',
    parts: [{ text: `RUNTIME-START-${'runtime-history '.repeat(20_000)}-RUNTIME-END` }]
  }]];
  const requestBodies = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const structured = [
    '目标', '- 无', '',
    '重要约束、决定和准确标识', '- 无', '',
    '工作状态', '  - 已完成', '    - 无',
    '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
    '下一步', '- 无', '', '相关文件', '- 无'
  ].join('\n');
  const server = http.createServer(async (req, res) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBodies.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-${requestBodies.length}`,
      object: 'chat.completion',
      created: 1,
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: structured }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    }));
    activeRequests -= 1;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const settings = {
    ...providerConfig(provider, `http://127.0.0.1:${address.port}/v1`),
    contextWindowTokens: 30_000,
    stream: false
  };
  const options = {
    settings: async () => settings,
    compressionSettings: async () => undefined
  };
  const capability = createLlmProviderCapability(options);
  try {
    const dryRun = await dryRunCompactLlmProvider(fixture.request, options);
    assert.equal(dryRun.kind, 'provider_requests');
    const terminal = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('compact runtime test timed out')), 30_000);
      capability.compact(fixture.request, (event) => {
        if (event.type === 'llm:compactError') {
          clearTimeout(timeout);
          reject(new Error(event.payload.message));
        }
        if (event.type === 'llm:compactDone') {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });
    assert.ok(requestBodies.length > dryRun.calls.length, 'runtime must add at least one hierarchy merge call');
    assert.ok(requestBodies.length <= 64, 'leaf + hierarchy + prior merge calls must stay inside the hard budget');
    assert.ok(maxActiveRequests <= 3, 'summary Provider concurrency must remain bounded at three');
    const leafWire = requestBodies.slice(0, dryRun.calls.length).join('\n');
    assert.match(leafWire, /RUNTIME-START/);
    assert.match(leafWire, /RUNTIME-END/);
    assert.match(requestBodies.at(-1), /新增分段摘要/);
    const finalText = terminal.payload.result.contents[0].parts[0].text;
    assert.match(finalText, /RUNTIME-START/);
    assert.match(finalText, /RUNTIME-END/);
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('segmented summary never retries a logical call or the whole operation after a Provider failure', async () => {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    requestCount += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'Unsupported parameter: max_output_tokens', type: 'invalid_request_error' }
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.segments = [[{ role: 'user', parts: [{ text: 'one bounded leaf' }] }]];
  const options = {
    settings: async () => ({
      ...providerConfig(provider, `http://127.0.0.1:${address.port}/v1`),
      stream: false,
      retryOnError: true,
      retryMaxAttempts: -1
    }),
    compressionSettings: async () => undefined
  };
  const capability = createLlmProviderCapability(options);
  const events = [];
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('compact failure test timed out')), 10_000);
      capability.compact(fixture.request, (event) => {
        events.push(event);
        if (event.type === 'llm:compactError') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    assert.equal(requestCount, 1);
    assert.equal(events.some((event) => event.type === 'llm:retryScheduled'), false);
    const terminal = events.find((event) => event.type === 'llm:compactError');
    assert.equal(terminal.payload.retryMaxAttempts, 0);
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});


test('deterministic fallback preserves first and last anchors beyond the per-field fact cap', async () => {
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.methodConfigSnapshot.llmSummary.targetTokens = 4_000;
  const facts = [
    'ANCHOR-FIRST',
    ...Array.from({ length: 80 }, (_, index) => `MIDDLE-${String(index).padStart(2, '0')}`),
    'ANCHOR-LAST'
  ];
  fixture.request.segments = [[{
    role: 'user',
    parts: [{ text: facts.map((fact) => `- ${fact}`).join('\n') }]
  }]];
  const emptyStructured = [
    '目标', '- 无', '',
    '重要约束、决定和准确标识', '- 无', '',
    '工作状态', '  - 已完成', '    - 无',
    '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
    '下一步', '- 无', '', '相关文件', '- 无'
  ].join('\n');
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-anchor', object: 'chat.completion', created: 1, model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: emptyStructured }, finish_reason: 'stop' }]
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const options = {
    settings: async () => ({
      ...providerConfig(provider, `http://127.0.0.1:${address.port}/v1`),
      stream: false
    }),
    compressionSettings: async () => undefined
  };
  const capability = createLlmProviderCapability(options);
  try {
    const terminal = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('anchor retention test timed out')), 10_000);
      capability.compact(fixture.request, (event) => {
        if (event.type === 'llm:compactError') {
          clearTimeout(timeout);
          reject(new Error(event.payload.message));
        }
        if (event.type === 'llm:compactDone') {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });
    const text = terminal.payload.result.contents[0].parts[0].text;
    assert.match(text, /ANCHOR-FIRST/);
    assert.match(text, /ANCHOR-LAST/);
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('text summary inspects each unique managed media body once and returns reusable F observations', async () => {
  const fixture = observationCompactRequest('llm_summary');
  const base64 = fixture.bytes.toString('base64');
  const requestBodies = [];
  let resolverCalls = 0;
  const structured = [
    '目标', '- Preserve the red status pixel from F1', '',
    '重要约束、决定和准确标识', '- F1 is visual-evidence.png', '',
    '工作状态', '  - 已完成', '    - Inspected F1',
    '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
    '下一步', '- 无', '', '相关文件', '- visual-evidence.png'
  ].join('\n');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requestBodies.push(body);
    const isObservation = body.includes('Attachment observation contract revision');
    const content = isObservation
      ? JSON.stringify({
          attachmentRef: 'F1',
          summary: 'A one-pixel red status indicator.',
          salientFacts: ['The indicator is red.', 'The image contains one visible pixel.'],
          uncertainties: ['No surrounding UI context is visible.']
        })
      : structured;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-observation-${requestBodies.length}`,
      object: 'chat.completion',
      created: 1,
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const options = {
    settings: async () => ({
      ...providerConfig('openai-compatible', `http://127.0.0.1:${address.port}/v1`),
      stream: false
    }),
    compressionSettings: async () => undefined,
    async resolveAttachment(input) {
      resolverCalls += 1;
      assert.equal(input.attachmentId, 'attachment-visual-evidence');
      return { inlineData: {
        mimeType: 'image/png', name: 'visual-evidence.png', data: base64,
        attachmentId: input.attachmentId, sizeBytes: fixture.bytes.byteLength
      } };
    }
  };
  const capability = createLlmProviderCapability(options);
  try {
    const terminal = await waitForCompactTerminal(capability, fixture.request);
    assert.equal(terminal.type, 'llm:compactDone', terminal.payload.message);
    assert.equal(resolverCalls, 1);
    assert.equal(requestBodies.length, 2, 'one observation call must precede one summary call');
    assert.match(requestBodies[0], /F1/);
    assert.match(requestBodies[0], new RegExp(base64.slice(0, 24)));
    assert.doesNotMatch(requestBodies[0], /attachment-visual-evidence|aaaaaaaaaaaaaaaa/);
    assert.doesNotMatch(requestBodies[1], new RegExp(base64.slice(0, 24)));
    assert.match(requestBodies[1], /one-pixel red status indicator/);
    assert.equal(terminal.payload.result.attachmentObservationProfileSha256, 'b'.repeat(64));
    assert.deepEqual(terminal.payload.result.attachmentObservations, [{
      attachmentRef: 'F1',
      summary: 'A one-pixel red status indicator.',
      salientFacts: ['The indicator is red.', 'The image contains one visible pixel.'],
      uncertainties: ['No surrounding UI context is visible.']
    }]);
    assert.equal(terminal.payload.result.contents.length, 2);
    assert.match(terminal.payload.result.contents[1].parts[0].text, /attachment_observation_state/);
    assert.match(terminal.payload.result.contents[1].parts[0].text, /"attachmentRef":"F1"/);
    assert.doesNotMatch(JSON.stringify(terminal.payload.result.contents), /attachment-visual-evidence/);
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('provider media rejection preserves the attachment with an explicit unknown observation and continues summary', async () => {
  const fixture = observationCompactRequest('llm_summary');
  fixture.request.id = 'observation-provider-rejected';
  fixture.request.blockId = 'observation-provider-rejected-block';
  const base64 = fixture.bytes.toString('base64');
  const requestBodies = [];
  let rejectObservation = true;
  const structured = [
    '目标', '- Preserve F1 without inventing visual details', '',
    '重要约束、决定和准确标识', '- F1 remains attached but unobserved', '',
    '工作状态', '  - 已完成', '    - Text compression completed',
    '  - 正在做', '    - 无', '  - 受阻', '    - Image observation unavailable', '',
    '下一步', '- Retry F1 with a compatible provider', '', '相关文件', '- visual-evidence.png'
  ].join('\n');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requestBodies.push(body);
    const isObservation = body.includes('Attachment observation contract revision');
    if (isObservation && rejectObservation) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream request failed', type: 'upstream_error' } }));
      return;
    }
    const content = isObservation
      ? JSON.stringify({
          attachmentRef: 'F1',
          summary: 'Recovered real visual observation.',
          salientFacts: ['The retry inspected the original image.'],
          uncertainties: []
        })
      : structured;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-fallback-summary', object: 'chat.completion', created: 1, model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const capability = createLlmProviderCapability({
    settings: async () => ({
      ...providerConfig('openai-compatible', `http://127.0.0.1:${address.port}/v1`),
      stream: false
    }),
    compressionSettings: async () => undefined,
    async resolveAttachment(input) {
      return { inlineData: {
        mimeType: 'image/png', name: 'visual-evidence.png', data: base64,
        attachmentId: input.attachmentId, sizeBytes: fixture.bytes.byteLength
      } };
    }
  });
  try {
    const terminal = await waitForCompactTerminal(capability, fixture.request);
    assert.equal(terminal.type, 'llm:compactDone', terminal.payload.message);
    assert.equal(requestBodies.length, 2, 'one rejected observation must be followed by text summary');
    assert.match(requestBodies[0], new RegExp(base64.slice(0, 24)));
    assert.doesNotMatch(requestBodies[1], new RegExp(base64.slice(0, 24)));
    assert.match(requestBodies[1], /Attachment content was not observed/);
    const fallbackObservation = {
      attachmentRef: 'F1',
      summary: 'Attachment F1 (visual-evidence.png) was preserved without content analysis.',
      salientFacts: [
        'Original attachment preserved as F1.',
        `Metadata: mimeType=image/png; sizeBytes=${fixture.bytes.byteLength}.`
      ],
      uncertainties: ['Attachment content was not observed; visual or media details remain unknown.']
    };
    assert.deepEqual(terminal.payload.result.attachmentObservations, [fallbackObservation]);

    rejectObservation = false;
    const retryFixture = observationCompactRequest('llm_summary', fallbackObservation);
    const retried = await waitForCompactTerminal(capability, retryFixture.request);
    assert.equal(retried.type, 'llm:compactDone', retried.payload.message);
    assert.equal(requestBodies.filter((body) => body.includes('Attachment observation contract revision')).length, 2);
    assert.equal(retried.payload.result.attachmentObservations[0].summary, 'Recovered real visual observation.');
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('successful media observation is reused when a later summary attempt retries', async () => {
  const fixture = observationCompactRequest('llm_summary');
  fixture.request.id = 'observation-summary-retry';
  fixture.request.blockId = 'observation-summary-retry-block';
  const base64 = fixture.bytes.toString('base64');
  const requestBodies = [];
  let resolverCalls = 0;
  let summaryAttempts = 0;
  const structured = [
    '目标', '- Preserve F1 after retry', '',
    '重要约束、决定和准确标识', '- F1 observation is durable', '',
    '工作状态', '  - 已完成', '    - Summary retry succeeded',
    '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
    '下一步', '- 无', '', '相关文件', '- visual-evidence.png'
  ].join('\n');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requestBodies.push(body);
    if (body.includes('Attachment observation contract revision')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-retry-observation', object: 'chat.completion', created: 1, model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
          attachmentRef: 'F1',
          summary: 'Retry-stable visual observation.',
          salientFacts: ['The status is red.'],
          uncertainties: []
        }) }, finish_reason: 'stop' }]
      }));
      return;
    }
    summaryAttempts += 1;
    if (summaryAttempts === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporary summary failure', type: 'server_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-retry-summary', object: 'chat.completion', created: 1, model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: structured }, finish_reason: 'stop' }]
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const options = {
    settings: async () => ({
      ...providerConfig('openai-compatible', `http://127.0.0.1:${address.port}/v1`),
      stream: false,
      retryOnError: true,
      retryMaxAttempts: 1
    }),
    compressionSettings: async () => undefined,
    async resolveAttachment() {
      resolverCalls += 1;
      return { inlineData: {
        mimeType: 'image/png', name: 'visual-evidence.png', data: base64,
        attachmentId: 'attachment-visual-evidence', sizeBytes: fixture.bytes.byteLength
      } };
    }
  };
  const capability = createLlmProviderCapability(options);
  try {
    const terminal = await waitForCompactTerminal(capability, fixture.request, 15_000);
    assert.equal(terminal.type, 'llm:compactDone', terminal.payload.message);
    assert.equal(summaryAttempts, 2);
    assert.equal(resolverCalls, 1);
    assert.equal(requestBodies.filter((body) =>
      body.includes('Attachment observation contract revision')
    ).length, 1);
    assert.equal(requestBodies.filter((body) => body.includes(base64.slice(0, 24))).length, 1);
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('compact dry-run exposes observation calls and never repeats media in the summary preview', async () => {
  const fixture = observationCompactRequest('llm_summary');
  const base64 = fixture.bytes.toString('base64');
  let resolverCalls = 0;
  const result = await dryRunCompactLlmProvider(fixture.request, {
    settings: async () => providerConfig('openai-compatible', 'https://example.test/v1'),
    compressionSettings: async () => undefined,
    async resolveAttachment() {
      resolverCalls += 1;
      return { inlineData: {
        mimeType: 'image/png', name: 'visual-evidence.png', data: base64,
        attachmentId: 'attachment-visual-evidence', sizeBytes: fixture.bytes.byteLength
      } };
    }
  });
  assert.equal(result.kind, 'provider_requests');
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].label, 'Attachment F1 observation');
  assert.equal(result.calls[1].label, 'Context Summary');
  assert.equal(resolverCalls, 1);
  assert.match(result.calls[0].bodyText, new RegExp(base64.slice(0, 24)));
  assert.doesNotMatch(result.calls[1].bodyText, new RegExp(base64.slice(0, 24)));
  assert.match(result.calls[1].bodyText, /dry-run placeholder/);
  assert.match(result.note, /F 附件/);
});

test('local summary preserves uncached media as unknown and reuses real cached observations without resolution', async () => {
  const missing = observationCompactRequest('deterministic_summary');
  let resolverCalls = 0;
  const options = {
    settings: async () => ({
      ...providerConfig('openai-compatible', 'https://example.test/v1'),
      apiKey: ''
    }),
    compressionSettings: async () => undefined,
    async resolveAttachment() {
      resolverCalls += 1;
      throw new Error('local summaries must not resolve media');
    }
  };
  const capability = createLlmProviderCapability(options);
  try {
    const fallback = await waitForCompactTerminal(capability, missing.request);
    assert.equal(fallback.type, 'llm:compactDone', fallback.payload.message);
    assert.deepEqual(fallback.payload.result.attachmentObservations, [{
      attachmentRef: 'F1',
      summary: 'Attachment F1 (visual-evidence.png) was preserved without content analysis.',
      salientFacts: [
        'Original attachment preserved as F1.',
        `Metadata: mimeType=image/png; sizeBytes=${missing.bytes.byteLength}.`
      ],
      uncertainties: ['Attachment content was not observed; visual or media details remain unknown.']
    }]);
    assert.match(fallback.payload.result.contents[1].parts[0].text, /Attachment content was not observed/);
    assert.equal(resolverCalls, 0);

    const uncontracted = observationCompactRequest('deterministic_summary');
    uncontracted.request.id = 'observation-deterministic-no-contract';
    uncontracted.request.blockId = 'observation-deterministic-no-contract-block';
    delete uncontracted.request.attachmentObservationProfileSha256;
    delete uncontracted.request.attachmentObservationRequirements;
    const noContract = await waitForCompactTerminal(capability, uncontracted.request);
    assert.equal(noContract.type, 'llm:compactError');
    assert.match(noContract.payload.message, /without a frozen F-reference observation contract/);
    assert.equal(resolverCalls, 0);

    const cachedObservation = {
      attachmentRef: 'F1',
      summary: 'Cached visual observation.',
      salientFacts: ['The status is red.'],
      uncertainties: []
    };
    const cached = observationCompactRequest('deterministic_summary', cachedObservation);
    const completed = await waitForCompactTerminal(capability, cached.request);
    assert.equal(completed.type, 'llm:compactDone', completed.payload.message);
    assert.equal(resolverCalls, 0);
    assert.deepEqual(completed.payload.result.attachmentObservations, [cachedObservation]);
    assert.match(completed.payload.result.contents[1].parts[0].text, /Cached visual observation/);
  } finally {
    capability.dispose();
  }
});

for (const [provider, baseUrl] of PROVIDERS) {
  test(`segmented summary splits one oversized source group safely for ${provider}`, async () => {
    const fixture = compactRequest(provider);
    const result = await dryRunCompactLlmProvider(fixture.request, {
      settings: async () => providerConfig(provider, baseUrl),
      compressionSettings: async () => undefined
    });

    assert.equal(result.kind, 'provider_requests');
    assert.ok(result.calls.length >= 2, 'one oversized source group must become multiple bounded calls');
    assert.match(result.note, /leaf summary requests/);
    assert.equal(result.calls.some((call) => call.label === 'Summary replacement merge'), false);
    const wire = result.calls.map((call) => call.bodyText).join('\n');
    assert.match(wire, /TEXT-START/);
    assert.match(wire, /TEXT-END/);
    assert.doesNotMatch(wire, /hierarchical compression fallback/);
    assert.match(wire, /TOOL-START/);
    assert.match(wire, /TOOL-END/);
    assert.ok(result.calls.every((call) => call.bodyText.length < fixture.oversizedToolResult.length));
  });
}

/** `replies` answers the requests in order (the last one repeats); `{ status }` answers with an HTTP error. */
async function compactWithReply(request, replies, sentBodies = []) {
  const queue = Array.isArray(replies) ? replies : [replies];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sentBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const reply = queue[Math.min(sentBodies.length, queue.length) - 1];
    if (typeof reply === 'object') {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'shorten failed' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-authoritative', object: 'chat.completion', created: 1, model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }]
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const capability = createLlmProviderCapability({
    settings: async () => ({ ...providerConfig('openai-compatible', `http://127.0.0.1:${address.port}/v1`), stream: false }),
    compressionSettings: async () => undefined
  });
  try {
    const terminal = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('authoritative summary test timed out')), 10_000);
      capability.compact(request, (event) => {
        if (event.type === 'llm:compactError') { clearTimeout(timeout); reject(new Error(event.payload.message)); }
        if (event.type === 'llm:compactDone') { clearTimeout(timeout); resolve(event); }
      });
    });
    return terminal.payload.result.contents[0].parts[0].text;
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
}

function toolHistoryRequest() {
  const fixture = compactRequest('openai-compatible');
  fixture.request.methodConfigSnapshot.llmSummary.targetTokens = 4_000;
  fixture.request.segments = [[
    { role: 'user', parts: [{ text: 'SOURCE-USER-ASK: read the config and report its port' }] },
    { role: 'model', parts: [{ id: 'call-config', functionCall: { name: 'read', args: { path: 'SOURCE-PATH/config.json' } } }] },
    { role: 'user', parts: [{ id: 'call-config', functionResponse: { name: 'read', response: { content: 'SOURCE-TOOL-RESULT {"port": 8080}' } } }] },
    { role: 'model', parts: [{ text: 'SOURCE-MODEL-REPLY: the port is 8080.' }] }
  ]];
  return fixture.request;
}

test('a structured model summary is the summary; raw source records are not merged into it', async () => {
  const reply = [
    '目标', '- 读取配置并报告端口', '',
    '重要约束、决定和准确标识', '- 配置文件是 SOURCE-PATH/config.json，端口 8080', '',
    '工作状态', '  - 已完成', '    - 已读取配置，端口为 8080',
    '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
    '下一步', '- 无', '', '相关文件', '- SOURCE-PATH/config.json'
  ].join('\n');
  const text = await compactWithReply(toolHistoryRequest(), reply);
  assert.match(text, /已读取配置，端口为 8080/);
  assert.match(text, /配置文件是 SOURCE-PATH\/config\.json/);
  // Before: every tool call/result was appended as raw JSON and every reply copied verbatim.
  assert.doesNotMatch(text, /historical_tool_(?:call|result)/);
  assert.doesNotMatch(text, /SOURCE-TOOL-RESULT|SOURCE-MODEL-REPLY|SOURCE-USER-ASK/);
});

test('a reply without the required headings (e.g. a refusal) still falls back to the deterministic summary', async () => {
  const text = await compactWithReply(toolHistoryRequest(), 'I cannot help with that request.');
  assert.doesNotMatch(text, /I cannot help/);
  assert.match(text, /SOURCE-USER-ASK/);
});

test('a model summary inside the target is kept verbatim: code blocks, numbering and nesting survive, a preamble is dropped', async () => {
  const body = [
    '目标', '- 给 /health 增加数据库检查，端口保持 8080', '',
    '重要约束、决定和准确标识', '- 超时 2 秒：', '  ```js', '  await withTimeout(pool.query(\'SELECT 1\'), 2000);', '  ```', '',
    '工作状态', '- 已完成：', '  1. 读取 package.json', '  2. 替换 /health 路由', '- 正在做：', '  - 补 withTimeout', '- 受阻：', '  - 无', '',
    '下一步', '1. 定义 withTimeout', '2. 重跑 npm test', '', '相关文件', '- src/server.js'
  ].join('\n');
  const sent = [];
  const text = await compactWithReply(toolHistoryRequest(), `好的，以下是摘要：\n\n${body}`, sent);
  assert.equal(text, `[Context Summary]\n\n${body}`);
  const system = JSON.stringify(sent[0].messages?.find((message) => message.role === 'system') ?? sent[0]);
  assert.match(system, /最多不超过 4000 tokens/);
  assert.match(system, /控制在约 3200 tokens/);
});

function oversizedSummaryRequest() {
  const request = toolHistoryRequest();
  request.methodConfigSnapshot.llmSummary.targetTokens = 300;
  return request;
}

const OVERSIZED_REPLY = [
  '目标', '- 保留的目标', '', '重要约束、决定和准确标识', '- 无', '',
  '工作状态', '  - 已完成', '    - 无', '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
  '下一步', '- 无', '', '相关文件',
  ...Array.from({ length: 200 }, (_, index) => `- src/generated/module-${index}/implementation-file-${index}.ts`)
].join('\n');

const systemTextOf = (body) => JSON.stringify(body.messages?.find((message) => message.role === 'system') ?? body);

test('a model summary over the target is shortened by the model itself and kept verbatim', async () => {
  const shortened = [
    '目标', '- 保留的目标', '', '重要约束、决定和准确标识', '- 生成文件共 200 个：', '  ```', '  src/generated/module-*/implementation-file-*.ts', '  ```', '',
    '工作状态', '- 已完成：', '  1. 生成模块', '- 正在做：无', '- 受阻：无', '', '下一步', '- 无', '', '相关文件', '- src/generated/'
  ].join('\n');
  const sent = [];
  const text = await compactWithReply(oversizedSummaryRequest(), [OVERSIZED_REPLY, shortened], sent);
  assert.equal(sent.length, 2);
  assert.match(systemTextOf(sent[1]), /删短到约 \d+ tokens/);
  assert.equal(JSON.stringify(sent[1].messages.find((message) => message.role === 'user')).includes('implementation-file-199'), true);
  assert.equal(text, `[Context Summary]\n\n${shortened}`);
});

test('a summary still over the target after the model shortened it is cut down mechanically', async () => {
  const sent = [];
  const text = await compactWithReply(oversizedSummaryRequest(), OVERSIZED_REPLY, sent);
  assert.equal(sent.length, 2, 'one summary request plus exactly one shorten request');
  assert.match(text, /保留的目标/);
  assert.ok(text.length < OVERSIZED_REPLY.length / 4, `expected the oversized summary to be cut, got ${text.length} chars`);
});

test('a failed shorten request falls back to the mechanical cut instead of failing the compression', async () => {
  const sent = [];
  const text = await compactWithReply(oversizedSummaryRequest(), [OVERSIZED_REPLY, { status: 500 }], sent);
  assert.equal(sent.length, 2);
  assert.match(text, /保留的目标/);
  assert.ok(text.length < OVERSIZED_REPLY.length / 4);
});

test('a summary inside the target sends no shorten request', async () => {
  const sent = [];
  await compactWithReply(toolHistoryRequest(), OVERSIZED_REPLY.split('\n').slice(0, 20).join('\n'), sent);
  assert.equal(sent.length, 1);
});

test('a limit too small for the seven empty headings sends no shorten request', async () => {
  for (const kind of ['segmented_summary', 'llm_summary']) {
    const request = toolHistoryRequest();
    request.methodKind = kind;
    request.methodConfigSnapshot.kind = kind;
    request.methodConfigSnapshot.llmSummary.targetTokens = 40;
    if (kind === 'llm_summary') {
      request.contents = request.segments.flat();
      delete request.segments;
    }
    const sent = [];
    const text = await compactWithReply(request, OVERSIZED_REPLY, sent);
    assert.equal(sent.length, 1, `${kind}: a shorten request cannot fit the headings under a 40-token limit`);
    assert.ok(text.length > 0);
  }
});

test('a shorten reply that is not shorter than the original is ignored', async () => {
  const longer = OVERSIZED_REPLY.replace('- 保留的目标', '- LONGER-SHORTEN-GOAL')
    + '\n' + Array.from({ length: 20 }, (_, index) => `- src/extra/added-by-shorten-${index}.ts`).join('\n');
  const sameLength = OVERSIZED_REPLY.replace('- 保留的目标', '- SAMELEN-SHORTEN-GOAL');
  for (const reply of [longer, sameLength]) {
    const sent = [];
    const text = await compactWithReply(oversizedSummaryRequest(), [OVERSIZED_REPLY, reply], sent);
    assert.equal(sent.length, 2);
    assert.match(text, /保留的目标/);
    assert.doesNotMatch(text, /LONGER-SHORTEN-GOAL|SAMELEN-SHORTEN-GOAL|added-by-shorten/);
  }
});

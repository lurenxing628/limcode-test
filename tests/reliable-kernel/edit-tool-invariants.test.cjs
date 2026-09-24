const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = process.cwd();
const { LocalFileToolPlanner } = require(path.join(
  root,
  'dist/extension/backend/reliableKernel/localFileToolPlanner.js'
));
const { validateEditToolArguments } = require(path.join(
  root,
  'dist/extension/shared/editToolArguments.js'
));
const { editToolParameters } = require(path.join(
  root,
  'dist/extension/backend/world/modules/tools/definitions/edit/index.js'
));
const { dryRunLlmProvider } = require(path.join(
  root,
  'dist/extension/backend/capabilities/llmProvider.js'
));

const editDefinition = { declaration: { name: 'edit' } };

async function withPlannerFile(bytes, action) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-edit-invariant-'));
  const absolutePath = path.join(tempRoot, 'sample.txt');
  await fs.writeFile(absolutePath, bytes);
  let resolverCalls = 0;
  const planner = new LocalFileToolPlanner(async () => {
    resolverCalls += 1;
    return {
      workEnvironmentId: 'edit-test',
      rootPath: tempRoot,
      targetPath: 'sample.txt',
      absolutePath
    };
  });
  try {
    return await action({ planner, absolutePath, resolverCalls: () => resolverCalls });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function planEdit(planner, argumentsValue) {
  const members = await planner.plan(editDefinition, { arguments: argumentsValue }, {});
  assert.equal(members.length, 1);
  return members[0];
}

test('shared validator and declaration enforce exactly one complete branch while tolerating empty placeholders', () => {
  const schema = editToolParameters();
  assert.equal(schema.required.includes('path'), true);
  assert.equal(schema.oneOf.length, 3);
  assert.equal(schema.properties.hunks.minItems, 1);

  assert.equal(validateEditToolArguments({
    path: 'sample.txt',
    hunks: [{ oldContent: 'a', newContent: 'b' }],
    insert: {},
    delete: {}
  }).mode, 'hunk');
  assert.equal(validateEditToolArguments({
    path: 'sample.txt',
    hunks: [],
    insert: { line: 1, content: 'x' },
    delete: {}
  }).mode, 'insert');
  assert.equal(validateEditToolArguments({
    path: 'sample.txt',
    hunks: [],
    insert: {},
    delete: { startLine: 1, endLine: 1 }
  }).mode, 'delete');
  assert.throws(() => validateEditToolArguments({ path: 'sample.txt' }), /exactly one edit branch/i);
  assert.throws(() => validateEditToolArguments({
    path: 'sample.txt',
    hunks: [{ oldContent: 'a', newContent: 'b' }],
    insert: { line: 1, content: 'x' }
  }), /exactly one edit branch/i);
});

test('provider dry-runs flatten only the edit union and retain complete branch schemas', async () => {
  const parameters = editToolParameters();
  const originalParameters = structuredClone(parameters);
  const flatParameters = structuredClone(parameters);
  delete flatParameters.oneOf;
  const cases = [
    ...['openai-compatible', 'openai-responses', 'claude', 'gemini']
      .map((provider) => ({ provider, stream: false })),
    // 官方 DeepSeek 接口在 OpenAI 兼容渠道里走接入库的 DeepSeek 格式。
    { provider: 'openai-compatible', stream: false, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    { provider: 'openai-responses', stream: true, openaiResponsesTransport: 'http' },
    { provider: 'openai-responses', stream: true, openaiResponsesTransport: 'websocket' }
  ];
  for (const providerSettings of cases) {
    const { provider } = providerSettings;
    const result = await dryRunLlmProvider({
      id: `edit-schema-${provider}`,
      invocationId: `edit-schema-${provider}`,
      conversationId: `edit-schema-${provider}`,
      contents: [{ role: 'user', parts: [{ text: 'edit a file' }] }],
      tools: [
        { name: 'edit', description: 'edit', parameters },
        { name: 'schema_probe', description: 'unrelated tool', parameters }
      ]
    }, {
      settings: async () => ({
        id: `provider-${provider}`,
        name: provider,
        provider,
        baseUrl: 'https://provider.invalid/v1',
        model: provider === 'gemini' ? 'gemini-2.5-flash' : 'test-model',
        models: [],
        apiKey: 'test-key',
        toolCallFormat: 'function-call',
        ...providerSettings,
        retryOnError: false,
        retryMaxAttempts: 0,
        enableMultimodalTools: true,
        promptCache: { enabled: false, mode: 'key', ttl: '30m' },
        modelConfigs: [],
        createdAt: 1,
        updatedAt: 1
      })
    });
    const declarations = provider === 'gemini' ? result.body.tools[0].functionDeclarations : result.body.tools;
    if (provider === 'openai-responses') {
      assert.equal(declarations[0].strict, false, 'Responses must not make all edit branches required through implicit strict mode');
      // Omitting strict makes Responses normalize every schema into strict mode (optional fields become
      // required): https://developers.openai.com/api/docs/guides/function-calling#strict-mode
      assert.equal(declarations[1].strict, false, 'Unrelated tools must not be normalized into implicit strict mode either');
    }
    const [schema, unrelatedSchema] = declarations.map((declaration) => provider === 'claude'
      ? declaration.input_schema
      : provider === 'openai-compatible'
        ? declaration.function.parameters
        : declaration.parameters);
    assert.equal(schema.oneOf, undefined, `${provider} must not send constraint-only edit union branches`);
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['path']);
    assert.equal(schema.properties.hunks.type, 'array');
    assert.equal(schema.properties.hunks.minItems, 1);
    assert.equal(schema.properties.hunks.items.type, 'object');
    assert.deepEqual(schema.properties.hunks.items.required, ['oldContent', 'newContent']);
    assert.equal(schema.properties.insert.type, 'object');
    assert.deepEqual(schema.properties.insert.required, ['line', 'content']);
    assert.equal(schema.properties.delete.type, 'object');
    assert.deepEqual(schema.properties.delete.required, ['startLine', 'endLine']);
    if (provider !== 'gemini') assert.deepEqual(schema, flatParameters);
    if (provider === 'openai-compatible' || provider === 'openai-responses') {
      assert.deepEqual(unrelatedSchema, originalParameters);
    }
    assert.deepEqual(parameters, originalParameters, `${provider} mutated the source schema`);
  }
});

test('path-only edit is rejected before path resolution or file inspection', async () => {
  await withPlannerFile('unchanged\n', async ({ planner, resolverCalls }) => {
    await assert.rejects(
      planEdit(planner, { path: 'sample.txt' }),
      /exactly one edit branch/i
    );
    assert.equal(resolverCalls(), 0);
  });
});

test('flattened provider schemas do not permit malformed or conflicting edits to reach files', async () => {
  await withPlannerFile('unchanged\n', async ({ planner, absolutePath, resolverCalls }) => {
    for (const argumentsValue of [
      { path: 'sample.txt', hunks: [] },
      { path: 'sample.txt', insert: {} },
      { path: 'sample.txt', hunks: [{ oldContent: 'unchanged' }] },
      { path: 'sample.txt', insert: { line: 0, content: 'changed' } },
      { path: 'sample.txt', delete: { startLine: 2, endLine: 1 } },
      {
        path: 'sample.txt',
        hunks: [{ oldContent: 'unchanged', newContent: 'changed' }],
        insert: { line: 1, content: ' ' },
        delete: { startLine: 1, endLine: 1 }
      },
      {
        path: 'sample.txt',
        hunks: [{ oldContent: 'unchanged', newContent: 'changed' }],
        delete: { startLine: 1, endLine: 1 }
      },
      {
        path: 'sample.txt',
        insert: { line: 1, content: 'changed' },
        delete: { startLine: 1, endLine: 1 }
      }
    ]) {
      await assert.rejects(planEdit(planner, argumentsValue), TypeError);
      assert.equal(resolverCalls(), 0);
    }
    assert.equal(await fs.readFile(absolutePath, 'utf8'), 'unchanged\n');
  });
});

test('hunk matching accepts LF arguments for a CRLF file and preserves CRLF', async () => {
  await withPlannerFile('alpha\r\nbeta\r\ngamma\r\n', async ({ planner }) => {
    const member = await planEdit(planner, {
      path: 'sample.txt',
      hunks: [{ oldContent: 'beta\ngamma', newContent: 'B\nC' }]
    });
    assert.equal(member.targetContent, 'alpha\r\nB\r\nC\r\n');
  });
});

test('hunk editing preserves a UTF-8 BOM and non-ASCII text', async () => {
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('你好\r\n世界\r\n', 'utf8')
  ]);
  await withPlannerFile(bytes, async ({ planner }) => {
    const member = await planEdit(planner, {
      path: 'sample.txt',
      hunks: [{ oldContent: '你好\n世界', newContent: '再见\n世界' }]
    });
    assert.equal(member.targetContent, '\ufeff再见\r\n世界\r\n');
    assert.deepEqual(Buffer.from(member.targetContent, 'utf8').subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

test('ordered hunks share one exact matcher across replaceAll, duplicates, and changed context', async () => {
  await withPlannerFile('one\r\ntwo\r\none\r\n', async ({ planner }) => {
    const member = await planEdit(planner, {
      path: 'sample.txt',
      hunks: [
        { oldContent: 'one', newContent: 'ONE', replaceAll: true },
        { oldContent: 'ONE\ntwo', newContent: 'uno\ndos' }
      ]
    });
    assert.equal(member.targetContent, 'uno\r\ndos\r\nONE\r\n');
  });
});

test('line insert/delete preserve CRLF and BOM semantics', async () => {
  await withPlannerFile(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('alpha\r\nbeta\r\n', 'utf8')
  ]), async ({ planner }) => {
    const inserted = await planEdit(planner, {
      path: 'sample.txt',
      insert: { line: 2, content: 'middle' }
    });
    assert.equal(inserted.targetContent, '\ufeffalpha\r\nmiddle\r\nbeta\r\n');

    const deleted = await planEdit(planner, {
      path: 'sample.txt',
      delete: { startLine: 1, endLine: 1 }
    });
    assert.equal(deleted.targetContent, '\ufeffbeta\r\n');
  });
});

test('exact matching never falls back to whitespace or case fuzz', async () => {
  await withPlannerFile('Alpha  beta\r\n', async ({ planner }) => {
    await assert.rejects(planEdit(planner, {
      path: 'sample.txt',
      hunks: [{ oldContent: 'alpha beta', newContent: 'changed' }]
    }), /no exact match/i);
  });
});

test('mixed-EOL files keep untouched separators while replacement uses the matched style', async () => {
  await withPlannerFile('a\r\nb\nc\rd', async ({ planner }) => {
    const member = await planEdit(planner, {
      path: 'sample.txt',
      hunks: [{ oldContent: 'a\nb\nc', newContent: 'x\ny\nz' }]
    });
    assert.equal(member.targetContent, 'x\r\ny\r\nz\rd');
  });
});

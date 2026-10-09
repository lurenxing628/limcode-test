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
const { inspectEditToolArguments, validateEditToolArguments } = require(path.join(
  root,
  'dist/extension/shared/editToolArguments.js'
));
const { editTool, editToolParameters } = require(path.join(
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

test('shared validator requires mode for new calls and tolerates empty placeholders', () => {
  const schema = editToolParameters();
  assert.deepEqual(schema.required, ['path', 'mode']);
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(schema.properties.mode.enum, ['hunk', 'insert', 'delete']);
  assert.equal(schema.properties.hunks.minItems, 1);

  assert.equal(validateEditToolArguments({
    path: 'sample.txt',
    mode: 'hunk',
    hunks: [{ oldContent: 'a', newContent: 'b' }],
    insert: {},
    delete: null
  }).mode, 'hunk');
  assert.deepEqual(validateEditToolArguments({
    path: 'sample.txt',
    mode: 'hunk',
    hunks: [{ oldContent: 'a', newContent: 'b' }],
    insert: { line: 1, content: 'unused' },
    delete: { startLine: 1, endLine: 1 }
  }).ignoredBranches, ['insert', 'delete']);
  assert.equal(validateEditToolArguments({
    path: 'sample.txt',
    insert: { line: 1, content: 'x' },
    hunks: [],
    delete: {}
  }).mode, 'insert');
  assert.equal(validateEditToolArguments({
    path: 'sample.txt',
    delete: { startLine: 1, endLine: 1 },
    hunks: [],
    insert: null
  }).mode, 'delete');
  assert.throws(() => validateEditToolArguments({ path: 'sample.txt' }), /select exactly one edit branch/i);
  assert.throws(() => validateEditToolArguments({ path: 'sample.txt', mode: 'insert' }), /edit\.insert must be complete/i);
  assert.deepEqual(inspectEditToolArguments({
    path: 'sample.txt',
    mode: 'hunk',
    hunks: [{ oldContent: 'a', newContent: 'b' }],
    insert: { line: 1, content: 'unused' },
    delete: { startLine: 1, endLine: 1 }
  }), {
    explicitMode: 'hunk',
    activeBranches: ['hunks', 'insert', 'delete'],
    selectedMode: 'hunk',
    ignoredBranches: ['insert', 'delete'],
    inferred: false
  });
});

test('provider schemas retain explicit mode without an edit-specific union rewrite', async () => {
  const parameters = editToolParameters();
  const originalParameters = structuredClone(parameters);
  const unrelatedParameters = { ...structuredClone(parameters), oneOf: [{ required: ['hunks'] }, { required: ['insert'] }] };
  const originalUnrelatedParameters = structuredClone(unrelatedParameters);
  const cases = [
    ...['openai-compatible', 'openai-responses', 'claude', 'gemini']
      .map((provider) => ({ provider, stream: false })),
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
        { name: 'schema_probe', description: 'unrelated tool', parameters: unrelatedParameters }
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
      assert.equal(declarations[0].strict, false);
      assert.equal(declarations[1].strict, false);
    }
    const [schema, unrelatedSchema] = declarations.map((declaration) => provider === 'claude'
      ? declaration.input_schema
      : provider === 'openai-compatible'
        ? declaration.function.parameters
        : declaration.parameters);
    assert.equal(schema.oneOf, undefined, `${provider} must not send constraint-only edit union branches`);
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['path', 'mode']);
    assert.deepEqual(schema.properties.mode.enum, ['hunk', 'insert', 'delete']);
    assert.equal(schema.properties.hunks.type, 'array');
    assert.equal(schema.properties.hunks.minItems, 1);
    assert.deepEqual(schema.properties.hunks.items.required, ['oldContent', 'newContent']);
    assert.equal(schema.properties.insert.type, 'object');
    assert.deepEqual(schema.properties.insert.required, ['line', 'content']);
    assert.equal(schema.properties.delete.type, 'object');
    assert.deepEqual(schema.properties.delete.required, ['startLine', 'endLine']);
    if (provider !== 'gemini') assert.deepEqual(schema, originalParameters);
    if (provider === 'openai-compatible' || provider === 'openai-responses') {
      assert.deepEqual(unrelatedSchema, originalUnrelatedParameters);
    }
    assert.deepEqual(parameters, originalParameters, `${provider} mutated the source schema`);
    assert.deepEqual(unrelatedParameters, originalUnrelatedParameters, `${provider} mutated the unrelated tool schema`);
  }
});

test('path-only and mode-only edit are rejected before path resolution or file inspection', async () => {
  await withPlannerFile('unchanged\n', async ({ planner, resolverCalls }) => {
    await assert.rejects(planEdit(planner, { path: 'sample.txt' }), /select exactly one edit branch/i);
    await assert.rejects(planEdit(planner, { path: 'sample.txt', mode: 'hunk' }), /edit\.hunks must be complete/i);
    assert.equal(resolverCalls(), 0);
  });
});

test('selected mode executes only its branch and never applies ignored real branches', async () => {
  await withPlannerFile('unchanged\n', async ({ planner, absolutePath, resolverCalls }) => {
    for (const [mode, targetContent, ignoredBranches] of [
      ['hunk', 'changed\n', ['insert', 'delete']],
      ['insert', 'unused\nunchanged\n', ['hunks', 'delete']],
      ['delete', '', ['hunks', 'insert']]
    ]) {
      const args = {
        path: 'sample.txt', mode,
        hunks: [{ oldContent: 'unchanged', newContent: 'changed' }],
        insert: { line: 1, content: 'unused' },
        delete: { startLine: 1, endLine: 1 }
      };
      const member = await planEdit(planner, args);
      assert.equal(member.targetContent, targetContent);
      assert.deepEqual(validateEditToolArguments(args).ignoredBranches, ignoredBranches);
    }
    assert.equal(resolverCalls(), 3);
    assert.equal(await fs.readFile(absolutePath, 'utf8'), 'unchanged\n');
  });
});

test('an explicit mode never switches to another complete branch when its own branch is empty or incomplete', async () => {
  await withPlannerFile('unchanged\n', async ({ planner, absolutePath, resolverCalls }) => {
    const complete = {
      path: 'sample.txt',
      hunks: [{ oldContent: 'unchanged', newContent: 'changed' }],
      insert: { line: 1, content: 'unused' },
      delete: { startLine: 1, endLine: 1 }
    };
    for (const [mode, branch, incompleteValues] of [
      ['hunk', 'hunks', [undefined, null, {}, [], [{}], [{ oldContent: 'unchanged' }]]],
      ['insert', 'insert', [undefined, null, {}, [], { line: 1 }, { content: 'x' }]],
      ['delete', 'delete', [undefined, null, {}, [], { startLine: 1 }, { endLine: 1 }]]
    ]) {
      for (const value of incompleteValues) {
        await assert.rejects(planEdit(planner, { ...complete, mode, [branch]: value }), /must be complete/);
      }
    }
    for (const mode of ['hunks', 'replace', 0, false]) {
      await assert.rejects(planEdit(planner, { ...complete, mode }), /edit\.mode must be one of/);
    }
    for (const mode of ['', null, '   ']) {
      await assert.rejects(planEdit(planner, { ...complete, mode }), /Conflicting branches.*Add mode/);
    }
    assert.equal(resolverCalls(), 0);
    assert.equal(await fs.readFile(absolutePath, 'utf8'), 'unchanged\n');
  });
});

test('empty placeholders permit inference and an empty newContent still deletes matched text', async () => {
  await withPlannerFile('remove keep', async ({ planner }) => {
    for (const placeholder of [undefined, null, {}, [], { line: null, content: '' }]) {
      const args = {
        path: 'sample.txt', hunks: [{ oldContent: 'remove ', newContent: '' }],
        insert: placeholder, delete: { startLine: null, endLine: null }
      };
      const validated = validateEditToolArguments(args);
      assert.equal(validated.inferred, true);
      assert.deepEqual(validated.ignoredBranches, []);
      assert.equal((await planEdit(planner, args)).targetContent, 'keep');
    }
    assert.equal(validateEditToolArguments({
      path: 'sample.txt', delete: { startLine: 1, endLine: 1 },
      hunks: [{ oldContent: '', newContent: '', replaceAll: null }], insert: null
    }).mode, 'delete');
  });
});

test('zero, false, real line numbers and dummy text keep their branch meaning', async () => {
  await withPlannerFile('unchanged\n', async ({ planner, resolverCalls }) => {
    const hunk = { path: 'sample.txt', hunks: [{ oldContent: 'unchanged', newContent: 'changed' }] };
    for (const insert of [{ line: 0, content: '' }, { line: false, content: '' }, { line: 1, content: '' }, { content: 'unused' }, 0, false]) {
      await assert.rejects(planEdit(planner, { ...hunk, insert }), /Conflicting branches.*Add mode/);
      assert.deepEqual(validateEditToolArguments({ ...hunk, mode: 'hunk', insert }).ignoredBranches, ['insert']);
    }
    for (const deletion of [{ startLine: 0, endLine: 0 }, { startLine: false }, { startLine: 1 }]) {
      await assert.rejects(planEdit(planner, { ...hunk, delete: deletion }), /Conflicting branches.*Add mode/);
    }
    assert.throws(() => validateEditToolArguments({
      path: 'sample.txt', delete: { startLine: 1, endLine: 1 },
      hunks: [{ oldContent: '', newContent: '', replaceAll: false }]
    }), /Conflicting branches.*Add mode/);
    assert.equal(resolverCalls(), 0);
  });
});

test('empty modes and harmless extra keys retain one complete edit branch', () => {
  for (const mode of [undefined, null, '', '   ']) {
    const validated = validateEditToolArguments({
      path: 'sample.txt', mode, note: 'extra context',
      hunks: [{ oldContent: 'a', newContent: '', replaceAll: null, note: 'ignored' }],
      insert: { note: 'no insertion requested' }, delete: { unknown: false }
    });
    assert.equal(validated.mode, 'hunk');
    assert.equal(validated.inferred, true);
    assert.deepEqual(validated.hunks, [{ oldContent: 'a', newContent: '', replaceAll: false }]);
    assert.deepEqual(validated.ignoredBranches, []);
  }
  assert.deepEqual(validateEditToolArguments({
    path: 'sample.txt', mode: 'insert', insert: { line: 1, content: 'x', note: 'ignored' }
  }).insert, { line: 1, content: 'x' });
  assert.deepEqual(validateEditToolArguments({
    path: 'sample.txt', mode: 'delete', delete: { startLine: 1, endLine: 1, note: 'ignored' }
  }).delete, { startLine: 1, endLine: 1 });
  for (const replaceAll of [undefined, null, '', '   ', {}, []]) {
    const validated = validateEditToolArguments({
      path: 'sample.txt', mode: ' HUNK ', hunks: [{ oldContent: ' ', newContent: ' \t', replaceAll }],
      insert: '   ', delete: '\t'
    });
    assert.equal(validated.mode, 'hunk');
    assert.equal(validated.inferred, false);
    assert.deepEqual(validated.hunks, [{ oldContent: ' ', newContent: ' \t', replaceAll: false }]);
    assert.deepEqual(validated.ignoredBranches, []);
    assert.equal(validateEditToolArguments({
      path: 'sample.txt', delete: { startLine: 1, endLine: 1 },
      hunks: [{ oldContent: '', newContent: '', replaceAll }], insert: ' '
    }).mode, 'delete');
  }
  for (const replaceAll of [0, 1, 'false', { nested: 'value' }, [false]]) {
    assert.throws(() => validateEditToolArguments({
      path: 'sample.txt', mode: 'hunk', hunks: [{ oldContent: 'a', newContent: 'b', replaceAll }]
    }), /replaceAll must be a boolean/);
  }
  assert.throws(() => validateEditToolArguments({
    path: 'sample.txt', mode: 'hunk', hunks: [{ oldContent: 'a', note: 'newContent is still required' }]
  }), /must be complete/);
  assert.equal(validateEditToolArguments({
    path: 'sample.txt', hunks: [{ oldContent: 'a', newContent: 'b' }], insert: ' ', delete: '\t'
  }).inferred, true);
  assert.deepEqual(validateEditToolArguments({
    path: 'sample.txt', mode: ' INSERT ', insert: { line: 1, content: '   ' }
  }).insert, { line: 1, content: '   ' });
  assert.throws(() => validateEditToolArguments({
    path: 'sample.txt', hunks: [{ oldContent: 'a', newContent: 'b' }], insert: { line: 1, content: '   ' }
  }), /Conflicting branches/);
});

test('no-mode malformed or conflicting arguments do not reach files', async () => {
  await withPlannerFile('unchanged\n', async ({ planner, absolutePath, resolverCalls }) => {
    for (const argumentsValue of [
      { path: 'sample.txt', hunks: [{ oldContent: 'unchanged', newContent: 'changed' }], insert: { line: 1, content: 'x' } },
      { path: 'sample.txt', insert: { line: 1, content: 'x' }, delete: { startLine: 1, endLine: 1 } },
      { path: 'sample.txt', mode: 'hunk', hunks: [{ oldContent: 'unchanged' }] },
      { path: 'sample.txt', mode: 'insert', insert: { line: 0, content: 'changed' } },
      { path: 'sample.txt', mode: 'delete', delete: { startLine: 2, endLine: 1 } }
    ]) {
      await assert.rejects(planEdit(planner, argumentsValue), TypeError);
      assert.equal(resolverCalls(), 0);
    }
    assert.equal(await fs.readFile(absolutePath, 'utf8'), 'unchanged\n');
  });
});

test('an ambiguous call returns the validation error without displaying a guessed execution mode', async () => {
  const result = await editTool.execute({
    path: 'sample.txt', hunks: [{ oldContent: 'a', newContent: 'b' }],
    insert: { line: 1, content: 'unused' }, delete: { startLine: 1, endLine: 1 }
  }, { fs: { proposeEditFile() { assert.fail('ambiguous edit reached the capability'); } } });
  assert.equal(result.ok, false);
  assert.equal(result.output.mode, undefined);
  assert.match(result.output.error, /Conflicting branches.*Add mode/);
});

test('hunk matching accepts LF arguments for a CRLF file and preserves CRLF', async () => {
  await withPlannerFile('alpha\r\nbeta\r\ngamma\r\n', async ({ planner }) => {
    const member = await planEdit(planner, {
      path: 'sample.txt', mode: 'hunk', hunks: [{ oldContent: 'beta\ngamma', newContent: 'B\nC' }]
    });
    assert.equal(member.targetContent, 'alpha\r\nB\r\nC\r\n');
  });
});

test('hunk editing preserves a UTF-8 BOM and non-ASCII text', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\r\n世界\r\n', 'utf8')]);
  await withPlannerFile(bytes, async ({ planner }) => {
    const member = await planEdit(planner, {
      path: 'sample.txt', mode: 'hunk', hunks: [{ oldContent: '你好\n世界', newContent: '再见\n世界' }]
    });
    assert.equal(member.targetContent, '\ufeff再见\r\n世界\r\n');
    assert.deepEqual(Buffer.from(member.targetContent, 'utf8').subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

test('ordered hunks share one matcher across replaceAll, duplicates, and changed context', async () => {
  await withPlannerFile('one\r\ntwo\r\none\r\n', async ({ planner }) => {
    const member = await planEdit(planner, {
      path: 'sample.txt', mode: 'hunk', hunks: [
        { oldContent: 'one', newContent: 'ONE', replaceAll: true },
        { oldContent: 'ONE\ntwo', newContent: 'uno\ndos' }
      ]
    });
    assert.equal(member.targetContent, 'uno\r\ndos\r\nONE\r\n');
  });
});

test('line insert/delete preserve CRLF and BOM semantics', async () => {
  await withPlannerFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\r\nbeta\r\n', 'utf8')]), async ({ planner }) => {
    const inserted = await planEdit(planner, { path: 'sample.txt', mode: 'insert', insert: { line: 2, content: 'middle' } });
    assert.equal(inserted.targetContent, '\ufeffalpha\r\nmiddle\r\nbeta\r\n');
    const deleted = await planEdit(planner, { path: 'sample.txt', mode: 'delete', delete: { startLine: 1, endLine: 1 } });
    assert.equal(deleted.targetContent, '\ufeffbeta\r\n');
  });
});

test('hunk matching never guesses case or different internal whitespace', async () => {
  await withPlannerFile('Alpha  beta\r\n', async ({ planner }) => {
    await assert.rejects(planEdit(planner, { path: 'sample.txt', mode: 'hunk', hunks: [{ oldContent: 'alpha beta', newContent: 'changed' }] }), /no match/i);
  });
});

test('mixed-EOL files keep untouched separators while replacement uses the matched style', async () => {
  await withPlannerFile('a\r\nb\nc\rd', async ({ planner }) => {
    const member = await planEdit(planner, { path: 'sample.txt', mode: 'hunk', hunks: [{ oldContent: 'a\nb\nc', newContent: 'x\ny\nz' }] });
    assert.equal(member.targetContent, 'x\r\ny\r\nz\rd');
  });
});

test('edit keeps execution selection and ignored branch diagnostics', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    acquireVsCodeApi() { return { postMessage() {}, getState() {}, setState() {} }; }
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const { createWebviewSsrServer } = await import('./webview-ssr-server.mjs');
  const server = await createWebviewSsrServer();
  t.after(() => server.close());
  const { editToolDisplay } = await server.ssrLoadModule('/src/components/content/toolDisplay/fileChangeToolDisplay.ts');
  const display = (args, result) => {
    const view = editToolDisplay({ toolName: 'edit', args, result, events: [], stringifyValue: JSON.stringify });
    return {
      ...view,
      inputDetails: view.inputSections.filter(section => section.kind === 'input'),
      outputDetails: (view.outputSections ?? []).filter(section => section.kind === 'output')
    };
  };
  const row = (section, label) => section.rows?.find((item) => item.label === label)?.value;
  const args = {
    path: 'sample.txt', mode: 'hunk', hunks: [{ oldContent: 'a', newContent: 'b' }],
    insert: { line: 1, content: 'unused' }, delete: { startLine: 1, endLine: 1 }
  };
  const pending = display(args);
  assert.equal(row(pending.inputDetails[0], '模式'), 'hunk');
  assert.equal(row(pending.inputDetails[0], '非空参数分支'), 'hunks、insert、delete');
  assert.equal(row(pending.inputDetails[0], '忽略的参数分支'), 'insert、delete');
  assert.deepEqual(JSON.parse(pending.inputDetails[1].text), args);

  const { mode: _mode, ...ambiguous } = args;
  const rejected = display(ambiguous);
  assert.equal(row(rejected.inputDetails[0], '模式'), undefined);
  assert.match(row(rejected.inputDetails[0], '参数错误'), /Conflicting branches.*Add mode/);
  assert.deepEqual(JSON.parse(rejected.inputDetails[1].text), ambiguous);
  const invalid = display({ ...args, mode: 'insert', insert: {} });
  assert.match(row(invalid.inputDetails[0], '参数错误'), /edit\.insert must be complete/);
  const unknown = display({ ...args, extra: null });
  assert.equal(row(unknown.inputDetails[0], '参数错误'), undefined);
  assert.equal(JSON.parse(unknown.inputDetails[1].text).extra, null);

  const inferred = display({ path: 'sample.txt', delete: { startLine: 1, endLine: 1 }, hunks: [], insert: null }, {
    mode: 'delete', inferredMode: true
  });
  assert.equal(row(inferred.inputDetails[0], '模式'), 'delete（自动识别）');
  assert.equal(row(inferred.outputDetails[0], '修改方式'), 'delete（自动识别）');
  const settled = display(args, { mode: 'hunk', ignoredBranches: ['insert', 'delete'], warning: '已选择 mode=hunk；未执行分支：insert、delete。', operations: [] });
  assert.equal(row(settled.outputDetails[0], '未执行分支'), 'insert、delete');
  assert.equal(row(settled.outputDetails[0], '说明'), '已选择 mode=hunk；未执行分支：insert、delete。');
});

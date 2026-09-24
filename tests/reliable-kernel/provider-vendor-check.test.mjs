import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// 固定模型接入库（vendor/unified-llm-provider-*.tgz）的一致性检查。
// `build-provider-debug-fork.mjs --check` 在每次 compile 前运行：除了 vendor 目录里的补丁与安装包摘要，
// 还要核对 package.json / package-lock.json 指向同一个安装包，以及 node_modules 里实际装的就是它，
// 否则换了 vendor 却没重装依赖时，测试和打包用的仍是旧库。

const root = process.cwd();
const script = path.join(root, 'scripts', 'reliable-kernel', 'build-provider-debug-fork.mjs');
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'provider-debug-provenance.json'), 'utf8'));

function fixture(mutate = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-provider-check-'));
  fs.cpSync(path.join(root, 'vendor'), path.join(dir, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(dir, 'package-lock.json'));
  const modules = path.join(dir, 'node_modules');
  fs.mkdirSync(modules);
  childProcess.execFileSync('tar', ['-xzf', path.join(dir, 'vendor', provenance.archive), '-C', modules]);
  fs.renameSync(path.join(modules, 'package'), path.join(modules, 'unified-llm-provider'));
  mutate(dir);
  return dir;
}

function check(dir) {
  const result = childProcess.spawnSync(process.execPath, [script, '--check'], { cwd: dir, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function editJson(file, edit) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(value);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('vendor、依赖声明与已安装包一致时 --check 通过', () => {
  const result = check(fixture());
  assert.equal(result.status, 0, result.output);
});

test('当前工作树的真实 node_modules 装的就是 vendor 里的安装包', () => {
  const result = childProcess.spawnSync(process.execPath, [script, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('已安装包的 dist 文件被改动、多出或缺少时 --check 失败', () => {
  const cases = {
    changed: (dir) => fs.appendFileSync(path.join(dir, 'node_modules/unified-llm-provider/dist/llm/response.js'), '\n// local edit\n'),
    extra: (dir) => fs.writeFileSync(path.join(dir, 'node_modules/unified-llm-provider/dist/extra.js'), 'export {};\n'),
    missing: (dir) => fs.rmSync(path.join(dir, 'node_modules/unified-llm-provider/dist/llm/formats/openai-compatible.js'))
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const result = check(fixture(mutate));
    assert.notEqual(result.status, 0, label);
    assert.match(result.output, /已安装/, label);
  }
});

test('已安装包的版本不对或根本没有安装时 --check 失败', () => {
  const stale = check(fixture((dir) => editJson(path.join(dir, 'node_modules/unified-llm-provider/package.json'), (pkg) => {
    pkg.version = '0.1.37-limcode.6';
  })));
  assert.notEqual(stale.status, 0);
  assert.match(stale.output, /已安装/);
  const absent = check(fixture((dir) => fs.rmSync(path.join(dir, 'node_modules/unified-llm-provider'), { recursive: true })));
  assert.notEqual(absent.status, 0);
  assert.match(absent.output, /已安装/);
});

test('package.json 或 package-lock.json 没有指向 vendor 里的安装包时 --check 失败', () => {
  const cases = {
    dependency: (dir) => editJson(path.join(dir, 'package.json'), (pkg) => {
      pkg.dependencies['unified-llm-provider'] = 'file:vendor/unified-llm-provider-0.1.37-limcode.6.tgz';
    }),
    lockRoot: (dir) => editJson(path.join(dir, 'package-lock.json'), (lock) => {
      lock.packages[''].dependencies['unified-llm-provider'] = 'file:vendor/unified-llm-provider-0.1.37-limcode.6.tgz';
    }),
    lockResolved: (dir) => editJson(path.join(dir, 'package-lock.json'), (lock) => {
      lock.packages['node_modules/unified-llm-provider'].resolved = 'file:vendor/unified-llm-provider-0.1.37-limcode.6.tgz';
    }),
    lockVersion: (dir) => editJson(path.join(dir, 'package-lock.json'), (lock) => {
      lock.packages['node_modules/unified-llm-provider'].version = '0.1.37-limcode.6';
    }),
    lockIntegrity: (dir) => editJson(path.join(dir, 'package-lock.json'), (lock) => {
      lock.packages['node_modules/unified-llm-provider'].integrity = 'sha512-AAAA';
    })
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const result = check(fixture(mutate));
    assert.notEqual(result.status, 0, label);
    assert.match(result.output, /package(?:-lock)?\.json/, label);
  }
});

// ---- 显式提示缓存的模型清单：扩展与接入库各有一份，必须一致 ----

const require = createRequire(import.meta.url);
const { supportsOpenAIExplicitPromptCache } = require(path.join(root, 'dist/extension/shared/openAIResponsesCapabilities.js'));
const unified = await import('unified-llm-provider');

function setLiteral(source, name) {
  const match = new RegExp(`${name}(?::[^=]+)?\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
  assert.ok(match, `找不到 ${name} 的清单`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]).sort();
}

/** 接入库对这个模型是否按显式缓存编码：instructions 转为带断点的 developer 消息。 */
function libraryUsesExplicitCache(model) {
  const body = new unified.OpenAIResponsesFormat(model, { enabled: true, mode: 'explicit' }).encodeRequest({
    systemInstruction: { parts: [{ text: 'You are helpful.' }] },
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
  }, true);
  return body.instructions === undefined && body.input[0]?.role === 'developer';
}

test('显式提示缓存模型清单：shared/openAIResponsesCapabilities.ts 与接入库一致', () => {
  // 显式缓存只支持 “GPT-5.6 and later”（https://developers.openai.com/api/docs/guides/prompt-caching）；
  // 扩展决定是否发 prompt_cache_options，接入库决定是否把 instructions 转成带断点的 developer 消息，两份清单漂移
  // 会让一边开启、另一边不开启。
  const extension = setLiteral(fs.readFileSync(path.join(root, 'shared/openAIResponsesCapabilities.ts'), 'utf8'), 'OPENAI_GPT56_AND_LATER_MODELS');
  const library = setLiteral(fs.readFileSync(path.join(root, 'node_modules/unified-llm-provider/dist/llm/formats/openai-responses.js'), 'utf8'), 'LIMCODE_EXPLICIT_PROMPT_CACHE_MODELS');
  assert.deepEqual(extension, library);

  const candidates = [
    ...library,
    ...library.map((model) => `${model}-2026-05-01`),
    ...library.map((model) => model.toUpperCase()),
    'gpt-5.5', 'gpt-5.4', 'gpt-5', 'gpt-6', 'gpt-6-sol-xhigh', '[az]gpt-5.6-sol', 'gpt-6-astra-pro', 'gpt-5.6-sol-20260501'
  ];
  for (const model of candidates) {
    assert.equal(supportsOpenAIExplicitPromptCache(model), libraryUsesExplicitCache(model), model);
  }
});

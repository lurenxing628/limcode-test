import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../../dist/extension/backend/application/runtimeBuildInfo.js');
const { getRuntimeBuildInfo } = require(modulePath);
const { debugCaptureSource } = require('../../dist/extension/backend/reliableKernel/debugCapture/source.js');

test('握手不重读模块正文，文件身份变化触发重载且不改已装载的取证来源', (t) => {
  const readFile = fs.readFileSync;
  const stat = fs.statSync;
  let reads = 0;
  let changed = false;
  fs.readFileSync = (...args) => { reads += 1; return readFile(...args); };
  fs.statSync = (file, options) => {
    const result = stat(file, options);
    return changed && file === modulePath ? { ...result, mtimeNs: result.mtimeNs + 1n } : result;
  };
  t.after(() => { fs.readFileSync = readFile; fs.statSync = stat; });
  const initial = getRuntimeBuildInfo();
  const source = debugCaptureSource('host-a');
  assert.equal(initial.reloadRequired, false);
  assert.equal(getRuntimeBuildInfo().currentBuildFingerprint, initial.currentBuildFingerprint);
  changed = true;
  const updated = getRuntimeBuildInfo();
  assert.equal(updated.reloadRequired, true);
  assert.notEqual(updated.currentBuildFingerprint, initial.buildFingerprint);
  assert.equal(getRuntimeBuildInfo().currentBuildFingerprint, updated.currentBuildFingerprint);
  assert.deepEqual(debugCaptureSource('host-a'), source);
  assert.equal(reads, 0);
});

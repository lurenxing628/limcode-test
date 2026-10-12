import assert from 'node:assert/strict';

import path from 'node:path';

import { createRequire } from 'node:module';

import { after, test } from 'node:test';

const require = createRequire(import.meta.url);

const Module = require('node:module');

const originalLoad = Module._load;

class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}

const vscode = {
  Uri,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: { fs: {} }
};

Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};

after(() => { Module._load = originalLoad; });

const {
  evaluateNativeCompressionGuard,
  planNativeCompressionRebase,
  selectBlockingNativePendingCalls
} = require('../../../dist/extension/backend/reliableKernel/nativeCompressionGuard.js');

function pendingCall(overrides = {}) {
  return {
    toolCallId: 'call-1',
    toolName: 'read_file',
    turnId: 'turn-1',
    callContextSegmentId: 'seg-call-1',
    settled: false,
    delivered: false,
    ...overrides
  };
}

function registerCases(test) {

test('压缩守卫：全窗口原生Compact遇未决调用必须延期', () => {
  const decision = evaluateNativeCompressionGuard({
    fullWindowRequired: true,
    facts: { pendingToolCalls: [pendingCall()], pendingSteeringInputs: 0 },
    orderedSegmentIds: ['s0', 's1', 'seg-call-1', 's3'],
    requestedSourceSegmentCount: 4
  });
  assert.equal(decision.status, 'defer');
  assert.equal(decision.reason, 'native_pending_tools');
  assert.equal(decision.pendingToolCalls, 1);
});
}

export { registerCases };

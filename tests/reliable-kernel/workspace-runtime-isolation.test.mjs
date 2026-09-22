import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const {
  resolveVscodeRuntimeDataRoot,
  resolveVscodeRuntimeSelectionPath,
  resolveVscodeWorkspaceRuntimePlacement,
  resolveVscodeWorkspaceRuntimeScope
} = require('../../dist/extension/backend/reliableKernel/vscodeRootAuthority.js');
const { createVscodeStoragePaths } = require('../../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const { loadRecordStore } = require('../../dist/extension/backend/capabilities/vscodeStorage/recordStore.js');
const { VscodeConfigurationAuthority } = require('../../dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js');
const { workEnvironmentIdFromUri } = require('../../dist/extension/shared/workEnvironmentCatalog.js');

test('Workspace身份保持稳定但不再参与当前Runtime选库', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-runtime-route-'));
  try {
    const first = resolveVscodeWorkspaceRuntimeScope({
      workspaceFolderUris: ['file:///workspace/first']
    });
    const firstAgain = resolveVscodeWorkspaceRuntimeScope({
      workspaceFolderUris: [' file:///workspace/first ', 'file:///workspace/first']
    });
    const second = resolveVscodeWorkspaceRuntimeScope({
      workspaceFolderUris: ['file:///workspace/second']
    });
    const folderSetA = resolveVscodeWorkspaceRuntimeScope({
      workspaceFolderUris: ['file:///workspace/b', 'file:///workspace/a']
    });
    const folderSetB = resolveVscodeWorkspaceRuntimeScope({
      workspaceFolderUris: ['file:///workspace/a', 'file:///workspace/b']
    });
    const untitledFolderSet = resolveVscodeWorkspaceRuntimeScope({
      workspaceFileUri: 'untitled:Untitled-42',
      workspaceFolderUris: ['file:///workspace/a', 'file:///workspace/b']
    });
    assert.equal(first.key, firstAgain.key);
    assert.notEqual(first.key, second.key);
    assert.equal(folderSetA.key, folderSetB.key);
    assert.equal(folderSetA.key, untitledFolderSet.key);

    const fixedRuntimeDataRoot = resolveVscodeRuntimeDataRoot({ globalStoragePath: root });

    const firstPlacement = await resolveVscodeWorkspaceRuntimePlacement({ globalStoragePath: root }, first);
    const secondPlacement = await resolveVscodeWorkspaceRuntimePlacement({ globalStoragePath: root }, second);
    const firstPlacementAgain = await resolveVscodeWorkspaceRuntimePlacement({ globalStoragePath: root }, firstAgain);

    assert.equal(firstPlacement.usesLegacyRuntime, true);
    assert.equal(firstPlacement.runtimeScopeRootPath, root);
    assert.equal(firstPlacement.runtimeDataRootPath, fixedRuntimeDataRoot);
    assert.equal(firstPlacementAgain.usesLegacyRuntime, true);
    assert.equal(secondPlacement.runtimeScopeRootPath, root);
    assert.equal(secondPlacement.runtimeDataRootPath, fixedRuntimeDataRoot);
    const selection = JSON.parse(await fs.readFile(
      resolveVscodeRuntimeSelectionPath({ globalStoragePath: root }),
      'utf8'
    ));
    assert.equal(selection.id, 'default');
    assert.equal(selection.initialized, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('两个配置Authority不会把对方Workspace持久化为不可用', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-environment-isolation-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const firstAuthority = new VscodeConfigurationAuthority(() => paths);
    const secondAuthority = new VscodeConfigurationAuthority(() => paths);
    const firstPath = path.join(root, 'first');
    const secondPath = path.join(root, 'second');
    const firstUri = vscode.Uri.file(firstPath).toString();
    const secondUri = vscode.Uri.file(secondPath).toString();
    const firstId = workEnvironmentIdFromUri(firstUri);
    const secondId = workEnvironmentIdFromUri(secondUri);

    await firstAuthority.synchronizeWorkspaceFolders([
      { uri: firstUri, name: 'First', rootPath: firstPath, index: 0 }
    ]);
    await secondAuthority.synchronizeWorkspaceFolders([
      { uri: secondUri, name: 'Second', rootPath: secondPath, index: 0 }
    ]);

    const persisted = await loadRecordStore(
      paths.workEnvironmentsRootUri,
      paths.workEnvironmentsIndexUri,
      'workEnvironment'
    );
    assert.equal(persisted.find((record) => record.id === firstId)?.available, true);
    assert.equal(persisted.find((record) => record.id === secondId)?.available, true);

    const firstSnapshot = await firstAuthority.configurationClientState();
    const secondSnapshot = await secondAuthority.configurationClientState();
    assert.equal(firstSnapshot.workEnvironments.find((record) => record.id === firstId)?.available, true);
    assert.equal(firstSnapshot.workEnvironments.find((record) => record.id === secondId)?.available, false);
    assert.equal(secondSnapshot.workEnvironments.find((record) => record.id === firstId)?.available, false);
    assert.equal(secondSnapshot.workEnvironments.find((record) => record.id === secondId)?.available, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createVscodeStub() {
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  class Uri {
    constructor(fsPath) {
      this.scheme = 'file';
      this.fsPath = path.resolve(fsPath);
      this.path = this.fsPath.split(path.sep).join('/');
    }
    static file(filePath) { return new Uri(filePath); }
    static joinPath(base, ...segments) { return new Uri(path.join(base.fsPath, ...segments)); }
    toString() { return `file://${this.path}`; }
  }
  return {
    Uri,
    FileType,
    workspace: {
      fs: {
        async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
        async readFile(uri) { return fs.readFile(uri.fsPath); },
        async writeFile(uri, bytes) {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, bytes);
        },
        async readDirectory(uri) {
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [
            entry.name,
            entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown
          ]);
        },
        async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
        async stat(uri) {
          const stat = await fs.stat(uri.fsPath);
          return {
            type: stat.isDirectory() ? FileType.Directory : FileType.File,
            ctime: stat.ctimeMs,
            mtime: stat.mtimeMs,
            size: stat.size
          };
        }
      }
    }
  };
}

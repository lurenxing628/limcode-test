import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Identity metadata for actual loaded modules and capture comparisons, never a content manifest. */
export function writeCompileBuildId(root = process.cwd()) {
  const commitSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const worktreeClean = childProcess.execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8'
  }).trim() === '';
  return publishBuildIdentity(root, { commitSha, worktreeClean });
}

/** A webview-only build cannot re-identify backend bytes that it did not compile. */
export function refreshWebviewBuildId(root = process.cwd()) {
  let backendSource = {};
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(root, 'dist/extension/compile-build-id.json'), 'utf8'));
    if (typeof previous.buildId === 'string' && previous.buildId) {
      if (typeof previous.commitSha === 'string') backendSource.commitSha = previous.commitSha;
      if (typeof previous.worktreeClean === 'boolean') backendSource.worktreeClean = previous.worktreeClean;
    }
  } catch {
    // No backend provenance is inferred from the current Git state.
  }
  return publishBuildIdentity(root, backendSource);
}

function publishBuildIdentity(root, backendSource) {
  const identity = { buildId: randomUUID(), ...backendSource };
  const outputPath = path.join(root, 'dist/extension/compile-build-id.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(identity)}\n`);
  return identity;
}

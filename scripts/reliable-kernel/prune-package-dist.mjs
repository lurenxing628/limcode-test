import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isPathBelow } from './lib/path-containment.mjs';

const root = process.cwd();
const extensionRoot = path.join(root, 'dist/extension');
const manifestPath = path.join(root, 'dist/package-runtime-closure.json');
const seedPaths = [
  'vscode/extension.js',
  // RuntimeDatabase/ProcessControlPlane resolve these by __dirname rather than CommonJS require().
  'backend/reliableKernel/databaseWorker.js',
  'backend/reliableKernel/processWrapper.js'
];

if (!fs.existsSync(extensionRoot)) throw new Error('dist/extension does not exist; run build before package pruning.');
const seeds = seedPaths.map((relative) => {
  const absolute = path.join(extensionRoot, relative);
  if (!fs.existsSync(absolute)) throw new Error(`Package runtime seed is missing: ${relative}`);
  return absolute;
});
const reachable = commonJsClosure(seeds);
const removed = [];
for (const file of walkFiles(extensionRoot)) {
  const relative = portable(path.relative(extensionRoot, file));
  if (file.endsWith('.js')) {
    if (reachable.has(file)) continue;
    fs.rmSync(file, { force: true });
    removed.push(relative);
    continue;
  }
  if (file.endsWith('.js.map')) {
    fs.rmSync(file, { force: true });
    removed.push(relative);
  }
}
removeEmptyDirectories(extensionRoot);
const entries = [...reachable]
  .sort()
  .map((file) => ({
    path: portable(path.relative(root, file)),
    sha256: sha256(fs.readFileSync(file))
  }));
const manifest = {
  kind: 'limcode-package-runtime-closure',
  generatedAt: new Date().toISOString(),
  seeds: seedPaths,
  files: entries,
  fileCount: entries.length,
  closureSha256: sha256(Buffer.from(entries.map((entry) => `${entry.path}\0${entry.sha256}`).join('\n'))),
  removedFileCount: removed.length
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`已裁剪安装包Runtime闭包：保留${manifest.fileCount}个JS，删除${manifest.removedFileCount}个不可达JS/map，closure=${manifest.closureSha256}。`);

function commonJsClosure(initial) {
  const seen = new Set();
  const stack = [...initial];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    if (!isPathBelow(extensionRoot, file)) throw new Error(`Package closure escaped dist/extension: ${file}`);
    if (!fs.existsSync(file)) throw new Error(`Package closure dependency is missing: ${portable(path.relative(root, file))}`);
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const unresolved = path.resolve(path.dirname(file), specifier);
      if (!isPathBelow(extensionRoot, unresolved)) {
        throw new Error(`Relative require escaped dist/extension: ${specifier} from ${file}`);
      }
      const target = resolveRelativeModule(unresolved);
      if (!target) {
        throw new Error(`Relative require target is missing: ${specifier} from ${portable(path.relative(root, file))}`);
      }
      stack.push(target);
    }
  }
  return seen;
}

function resolveRelativeModule(unresolved) {
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [unresolved, `${unresolved}.js`, `${unresolved}.json`, path.join(unresolved, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function walkFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

function removeEmptyDirectories(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    removeEmptyDirectories(child);
    if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function portable(value) {
  return value.split(path.sep).join('/');
}

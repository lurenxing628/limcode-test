import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = path.join(root, 'node_modules', 'better-sqlite3');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
if (packageJson.version !== '13.0.2') {
  throw new Error(`Unreviewed better-sqlite3 version: ${packageJson.version}`);
}

const bindingPath = path.join(packageRoot, 'lib', 'binding.js');
const original = "function isLinuxMusl() {\n\treturn process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;\n}";
const patched = `function isLinuxMusl() {
\tif (process.platform !== 'linux') return false;
\tconst header = process.report?.getReport?.()?.header;
\tif (header) return !header.glibcVersionRuntime;
\t// VS Code's remote Extension Host can return undefined from getReport().
\t// Inspect the musl loader instead of treating an absent report as musl.
\tconst loader = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
\treturn fs.existsSync('/lib/ld-musl-' + loader + '.so.1');
}`;
const source = fs.readFileSync(bindingPath, 'utf8');
if (source.includes(patched)) {
  console.log('better-sqlite3 report guard already present.');
} else if (source.includes(original)) {
  fs.writeFileSync(bindingPath, source.replace(original, patched));
  console.log('Applied better-sqlite3 report guard for VS Code Extension Host.');
} else {
  throw new Error('Unreviewed better-sqlite3 binding.js structure; report guard was not applied.');
}

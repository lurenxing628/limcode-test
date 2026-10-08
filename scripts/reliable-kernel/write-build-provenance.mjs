import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// 构建后读取 package.json 的真实 main entry，写入供 installed gate 重算的 provenance。
const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { buildId, commitSha, worktreeClean } = JSON.parse(fs.readFileSync(path.join(root, 'dist/extension/compile-build-id.json'), 'utf8'));
const mainEntryRelative = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : '';
if (!mainEntryRelative || path.isAbsolute(mainEntryRelative) || mainEntryRelative.split(/[\\/]/).includes('..')) {
  console.error('构建来源写入失败：package.json.main缺失或不是安全的项目内相对路径。');
  process.exit(1);
}
const mainEntry = path.join(root, mainEntryRelative);
if (!fs.existsSync(mainEntry) || !fs.statSync(mainEntry).isFile()) {
  console.error(`构建来源写入失败：缺少package.json.main指向的构建产物${mainEntryRelative}，请先运行npm run compile。`);
  process.exit(1);
}

const mainEntrySha256 = crypto.createHash('sha256').update(fs.readFileSync(mainEntry)).digest('hex');
const outputRelative = 'dist/build-provenance.json';
fs.mkdirSync(path.dirname(path.join(root, outputRelative)), { recursive: true });
fs.writeFileSync(
  path.join(root, outputRelative),
  `${JSON.stringify({ buildId, commitSha, mainEntrySha256, worktreeClean }, null, 2)}\n`
);
console.log(`已写入构建来源：${outputRelative}（main=${mainEntryRelative}，commit=${commitSha}，worktreeClean=${worktreeClean}，mainEntrySha256=${mainEntrySha256}）。`);

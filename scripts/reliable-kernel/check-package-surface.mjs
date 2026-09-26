import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const root = process.cwd();
const artifact = option('artifact');
const listing = artifact ? listArtifactFiles(artifact) : listWorkspaceCandidateFiles();
const files = listing.files;
const manifest = listing.manifest;
const sqliteBinding = listing.sqliteBinding;

const failures = [];
const forbidden = [
  {
    id: '测试',
    match: (file) => {
      const base = path.posix.basename(file);
      return /(^|\/)(?:test|tests|spec|specs|__tests__)\//i.test(file)
        || /^(?:test|spec)-/i.test(base)
        || /^(?:tests?|specs?)\.(?:[cm]?js|tsx?|jsx?)$/i.test(base)
        || /\.(?:test|spec)\.[^/]+$/i.test(base);
    }
  },
  { id: '夹具', match: (file) => /(^|\/)fixtures?\//i.test(file) },
  {
    id: '基准',
    match: (file) => {
      const base = path.posix.basename(file);
      return /(^|\/)benchmarks?\//i.test(file)
        || /^benchmark-/i.test(base)
        || /\.benchmark\.[^/]+$/i.test(base);
    }
  },
  { id: '正式或基准脚本', match: (file) => /^scripts\//.test(file) },
  {
    id: '未批准的根级Markdown',
    match: (file) => !file.includes('/') && file.toLowerCase().endsWith('.md') && file.toLowerCase() !== 'readme.md'
  },
  { id: '内部架构文档', match: (file) => /(^|\/)docs\/architecture\//.test(file) },
  { id: '内部工具报告', match: (file) => /(^|\/)\.ide-tool-test\//.test(file) },
  { id: '存储研究资料', match: (file) => /^limcode-storage-topology-research\//.test(file) },
  { id: 'TypeScript或Vue源码', match: (file) => /^(backend|shared|vscode|webview)\/.*\.(?:ts|tsx|vue)$/.test(file) },
  { id: '嵌套VSIX', match: (file) => file.endsWith('.vsix') },
  { id: '运行数据库', match: (file) => /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/.test(file) || /-(?:wal|shm)$/.test(file) },
  { id: '原始日志或环境文件', match: (file) => /(^|\/)(?:\.env(?:\..*)?|.*\.(?:log|trace))$/.test(file) }
];
for (const rule of forbidden) {
  const matches = files.filter(rule.match);
  if (matches.length) failures.push(`${rule.id}: ${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ` (+${matches.length - 8})` : ''}`);
}

const required = [
  'package.json',
  String(manifest.main ?? '').replace(/^\.\//, ''),
  'node_modules/better-sqlite3/prebuilds/linux-x64.node',
  'node_modules/better-sqlite3/prebuilds/win32-x64.node',
  'node_modules/better-sqlite3/prebuilds/darwin-x64.node',
  'node_modules/better-sqlite3/prebuilds/darwin-arm64.node'
];
for (const file of required) if (!files.includes(file)) failures.push(`安装包缺少必需文件：${file}`);
if (!sqliteBinding?.includes("process.report?.getReport?.()?.header")
  || !sqliteBinding.includes("fs.existsSync('/lib/ld-musl-' + loader + '.so.1')")) {
  failures.push('better-sqlite3 缺少 VS Code Extension Host 的 process.report 兼容修补');
}
if (!files.some((file) => file.toLowerCase() === 'readme.md')) failures.push('安装包缺少README');
if (!files.some((file) => /^license(?:\.[^/]+)?$/i.test(file))) failures.push('安装包缺少LICENSE');
if (!files.some((file) => file.startsWith('dist/webview/') && file.endsWith('.html'))) failures.push('安装包缺少编译后的网页视图HTML');
if (!files.some((file) => file.startsWith('dist/webview/') && file.endsWith('.css'))) failures.push('安装包缺少编译后的网页视图CSS');

if (failures.length) {
  console.error(`VSIX内容检查失败：${files.length}个文件中发现${failures.length}项阻塞问题。`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const sourceMapCount = files.filter((file) => file.endsWith('.map')).length;
  console.log(`VSIX内容检查通过：共${files.length}个文件；测试、内部报告和源码数据库产物为0；源码映射文件${sourceMapCount}个，允许用于本机调试。`);
}

function listWorkspaceCandidateFiles() {
  const result = childProcess.spawnSync('npx', ['--no-install', 'vsce', 'ls'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    console.error('VSIX内容检查失败：无法通过vsce ls取得候选文件清单。');
    if (result.error) console.error(result.error.message);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }
  return {
    files: lines(result.stdout),
    manifest: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
    sqliteBinding: fs.readFileSync(path.join(root, 'node_modules/better-sqlite3/lib/binding.js'), 'utf8')
  };
}

function listArtifactFiles(relativeArtifactPath) {
  const absolute = path.resolve(root, relativeArtifactPath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    console.error(`VSIX内容检查失败：artifact不存在：${relativeArtifactPath}`);
    process.exit(1);
  }
  try {
    const archive = readZipArchive(fs.readFileSync(absolute));
    const manifestBytes = archive.read('extension/package.json');
    if (!manifestBytes) throw new Error('extension/package.json不存在');
    return {
      files: archive.names
        .map((file) => file.replace(/^extension\//, ''))
        .filter((file) => file && file !== '[Content_Types].xml' && file !== 'extension.vsixmanifest'),
      manifest: JSON.parse(manifestBytes.toString('utf8')),
      sqliteBinding: archive.read('extension/node_modules/better-sqlite3/lib/binding.js')?.toString('utf8')
    };
  } catch (error) {
    console.error(`VSIX内容检查失败：无法读取artifact ZIP清单或package.json：${error.message}`);
    process.exit(1);
  }
}

/** Minimal ZIP central-directory reader; avoids a platform dependency on the external unzip CLI. */
function readZipArchive(bytes) {
  const endSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const minimumEndOffset = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('ZIP end-of-central-directory记录缺失');
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== centralSignature) throw new Error('ZIP central-directory记录损坏');
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    entries.set(name, { compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return {
    names: [...entries.keys()].sort(),
    read(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      const localOffset = entry.localHeaderOffset;
      if (bytes.readUInt32LE(localOffset) !== localSignature) throw new Error(`ZIP local header损坏：${name}`);
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
      if (entry.compressionMethod === 0) return Buffer.from(compressed);
      if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`ZIP compression method不支持：${entry.compressionMethod}`);
    }
  };
}

function lines(value) {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).sort();
}

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

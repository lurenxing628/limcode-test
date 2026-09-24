import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const directory = path.join(root, 'vendor');
const packageName = 'unified-llm-provider';
const revision = '7857da99d5faec0865b8a402eb9c9d828f87b114';
const version = '0.1.37-limcode.7';
const archive = `${packageName}-${version}.tgz`;
const patch = 'unified-llm-provider.patch';
const manifest = path.join(directory, 'provider-debug-provenance.json');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha256Buffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** npm pack 产出的 tgz（ustar，可能带 pax 扩展头）里 package/ 下每个普通文件的内容。 */
function readPackedFiles(file) {
  const tar = zlib.gunzipSync(fs.readFileSync(file));
  const files = new Map();
  let paxPath;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const prefix = field(345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = match?.[1];
      continue;
    }
    if (type === 'g') continue;
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    if ((type === '0' || type === '7') && name.startsWith('package/')) files.set(name.slice('package/'.length), body);
  }
  return files;
}

function listFiles(base, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(base, child));
    else result.push(child);
  }
  return result;
}

/** package.json 与 package-lock.json 都指向 vendor 里的这个安装包，lock 里的版本和 integrity 与它一致。 */
function checkDependencyDeclarations(archiveFile) {
  const specifier = `file:vendor/${archive}`;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.dependencies?.[packageName] !== specifier) {
    throw new Error(`package.json 的 ${packageName} 依赖应为 ${specifier}，实际是 ${pkg.dependencies?.[packageName]}。`);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const locked = lock.packages?.[`node_modules/${packageName}`];
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(archiveFile)).digest('base64')}`;
  if (lock.packages?.['']?.dependencies?.[packageName] !== specifier
    || locked?.resolved !== specifier || locked?.version !== version || locked?.integrity !== integrity) {
    throw new Error(`package-lock.json 里的 ${packageName} 没有锁定到 ${specifier}（版本 ${version}、integrity 与安装包一致）。`);
  }
}

/** node_modules 里实际安装的包：版本一致，dist 文件集合与每个文件内容都与安装包相同。 */
function checkInstalledPackage(archiveFile) {
  const installed = path.join(root, 'node_modules', packageName);
  const installedManifest = path.join(installed, 'package.json');
  if (!fs.existsSync(installedManifest)) {
    throw new Error(`没有找到已安装的 ${packageName}（${installed}），请先安装依赖。`);
  }
  const installedVersion = JSON.parse(fs.readFileSync(installedManifest, 'utf8')).version;
  if (installedVersion !== version) {
    throw new Error(`已安装的 ${packageName} 版本是 ${installedVersion}，应为 ${version}，请重新安装依赖。`);
  }
  const packed = new Map([...readPackedFiles(archiveFile)]
    .filter(([name]) => name.startsWith('dist/'))
    .map(([name, body]) => [name, sha256Buffer(body)]));
  const installedDist = path.join(installed, 'dist');
  const actual = new Map(fs.existsSync(installedDist)
    ? listFiles(installedDist).map((name) => [`dist/${name}`, sha256(path.join(installedDist, name))])
    : []);
  const differing = [...new Set([...packed.keys(), ...actual.keys()])]
    .filter((name) => packed.get(name) !== actual.get(name))
    .sort();
  if (packed.size === 0 || differing.length > 0) {
    throw new Error(`已安装的 ${packageName} 与 vendor/${archive} 的 dist 不一致（${differing.slice(0, 5).join('、') || '安装包里没有 dist'}${differing.length > 5 ? ` 等 ${differing.length} 个文件` : ''}），请重新安装依赖。`);
  }
}

if (process.argv.includes('--check')) {
  const source = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const archiveFile = path.join(directory, archive);
  if (source.upstreamCommit !== revision || source.version !== version || source.archive !== archive
    || source.archiveSha256 !== sha256(archiveFile)
    || source.patchSha256 !== sha256(path.join(directory, patch))) {
    throw new Error('固定模型接入库的补丁或安装包摘要不匹配。');
  }
  checkDependencyDeclarations(archiveFile);
  checkInstalledPackage(archiveFile);
  console.log('固定模型接入库来源与摘要匹配，依赖声明与已安装包都是这个安装包。');
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-provider-build-'));
  const source = path.join(temporary, 'source');
  const run = (command, args, cwd = source) => execFileSync(command, args, { cwd, stdio: 'inherit' });
  try {
    run('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/Lianues/unified-llm-provider.git', source], temporary);
    run('git', ['checkout', '--detach', revision]);
    run('git', ['apply', '--check', path.join(directory, patch)]);
    run('git', ['apply', path.join(directory, patch)]);
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    run('npm', ['run', 'build']);
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', directory]);
    fs.writeFileSync(manifest, JSON.stringify({
      upstreamPackage: 'unified-llm-provider@0.1.37',
      upstreamCommit: revision,
      version,
      archive,
      archiveSha256: sha256(path.join(directory, archive)),
      patchSha256: sha256(path.join(directory, patch))
    }, null, 2) + '\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

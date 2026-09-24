import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const directory = path.join(root, 'vendor');
const revision = '7857da99d5faec0865b8a402eb9c9d828f87b114';
const version = '0.1.37-limcode.7';
const archive = `unified-llm-provider-${version}.tgz`;
const patch = 'unified-llm-provider.patch';
const manifest = path.join(directory, 'provider-debug-provenance.json');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (process.argv.includes('--check')) {
  const source = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (source.upstreamCommit !== revision || source.archive !== archive
    || source.archiveSha256 !== sha256(path.join(directory, archive))
    || source.patchSha256 !== sha256(path.join(directory, patch))) {
    throw new Error('固定模型接入库的补丁或安装包摘要不匹配。');
  }
  console.log('固定模型接入库来源与摘要匹配。');
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

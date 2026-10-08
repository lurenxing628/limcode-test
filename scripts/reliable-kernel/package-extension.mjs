import childProcess from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createVSIX } from '@vscode/vsce';

const targets = ['linux-x64', 'win32-x64', 'darwin-x64', 'darwin-arm64'];
const args = process.argv.slice(2);
let all = false;
let target;
let output;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--all') all = true;
  else if (argument === '--target' || argument === '--out') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    if (argument === '--target') target = value;
    else output = value;
  } else if (argument.startsWith('--target=')) target = argument.slice('--target='.length);
  else if (argument.startsWith('--out=')) output = argument.slice('--out='.length);
  else throw new Error(`Unknown package option: ${argument}`);
}
if (all && target) throw new Error('--all and --target cannot be used together.');
if (target && !targets.includes(target)) throw new Error(`Unsupported package target: ${target}`);
if (all && output && !output.includes('{target}')) throw new Error('--out must include {target} when using --all.');

const root = process.cwd();
const npmCli = process.env.npm_execpath;
const preparation = childProcess.spawnSync(
  npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm',
  npmCli ? [npmCli, 'run', 'build'] : ['run', 'build'],
  { cwd: root, stdio: 'inherit', shell: !npmCli && process.platform === 'win32' }
);
if (preparation.error) throw preparation.error;
if (preparation.status !== 0) process.exit(preparation.status ?? 1);
const pruning = childProcess.spawnSync(process.execPath, ['scripts/reliable-kernel/prune-package-dist.mjs'], {
  cwd: root, stdio: 'inherit'
});
if (pruning.error) throw pruning.error;
if (pruning.status !== 0) process.exit(pruning.status ?? 1);

for (const packageTarget of all ? targets : [target]) {
  const packagePath = output ? path.resolve(root, output.replaceAll('{target}', packageTarget ?? 'universal')) : undefined;
  await createVSIX({ cwd: root, target: packageTarget, packagePath, allowMissingRepository: true });
}

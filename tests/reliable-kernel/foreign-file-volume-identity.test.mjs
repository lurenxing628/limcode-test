import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { readLocatedRuntimeFile, sameOpenedFile } = require(path.join(compiled, 'backend/reliableKernel/runtimeForeignHistory.js'));
const fullDevice = 0x1234_5678_89ab_cdefn;
const descriptorDevice = 0x89ab_cdefn;
const allPlatforms = ['win32', 'linux', 'darwin'];

const cases = [
  { name: 'known 32-bit equality', pathnameDev: 7n, openedDev: 7n, accepted: allPlatforms },
  { name: 'known 32-bit mismatch', pathnameDev: 7n, openedDev: 8n, accepted: [] },
  { name: 'known 64-bit equality', pathnameDev: fullDevice, openedDev: fullDevice, accepted: allPlatforms },
  { name: '64-bit pathname to matching 32-bit descriptor', pathnameDev: fullDevice, openedDev: descriptorDevice, accepted: ['win32'] },
  { name: '64-bit pathname to different 32-bit descriptor', pathnameDev: fullDevice, openedDev: descriptorDevice + 1n, accepted: [] },
  { name: 'missing pathname device to positive 32-bit descriptor', pathnameDev: 0n, openedDev: 7n, accepted: ['win32'] },
  { name: 'missing pathname device still rejects a different file id', pathnameDev: 0n, openedDev: 7n, differentInode: true, accepted: [] },
  { name: '32-bit pathname to 64-bit descriptor is not a reverse bridge', pathnameDev: descriptorDevice, openedDev: fullDevice, accepted: [] },
  { name: 'missing pathname device does not accept a 64-bit descriptor', pathnameDev: 0n, openedDev: fullDevice, accepted: [] },
  { name: 'descriptor zero is not a reverse wildcard', pathnameDev: 7n, openedDev: 0n, accepted: [] }
];

test('外来文件的卷身份桥接保留仅 dev/ino 的比较器合同', () => {
  for (const scenario of cases) {
    // The existing comparison API accepts identity-only inputs; it does not require a complete stat.
    const found = { dev: scenario.pathnameDev, ino: 1125899908206697n };
    const opened = { dev: scenario.openedDev, ino: found.ino + (scenario.differentInode ? 1n : 0n) };
    for (const platform of allPlatforms) {
      assert.equal(sameOpenedFile(found, opened, platform), scenario.accepted.includes(platform), `${platform}: ${scenario.name}`);
    }
  }
});

test('外来文件读取只接受合法的 Windows 路径到句柄卷身份桥接', async (t) => {
  for (const scenario of cases) {
    await t.test(scenario.name, async (sub) => {
      const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foreign-volume-')));
      const target = path.join(directory, 'record.json');
      const originalLstat = fs.lstat, originalOpen = fs.open;
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      let pathnameStats = 0, descriptorStats = 0, targetReads = 0, closes = 0;
      try {
        await fs.writeFile(target, '{"fixture":"foreign volume identity"}');
        const initial = await originalLstat(target, { bigint: true });
        sub.mock.method(fs, 'lstat', async (input, ...args) => {
          const stat = await originalLstat(input, ...args);
          if (String(input) === target && args[0]?.bigint) {
            pathnameStats++;
            stat.dev = scenario.pathnameDev;
          }
          return stat;
        });
        sub.mock.method(fs, 'open', async (input, ...args) => {
          const handle = await originalOpen(input, ...args);
          if (String(input) === target) {
            const originalStat = handle.stat.bind(handle);
            const originalRead = handle.readFile.bind(handle);
            const originalClose = handle.close.bind(handle);
            handle.stat = async (...statArgs) => {
              descriptorStats++;
              const stat = await originalStat(...statArgs);
              stat.dev = scenario.openedDev;
              stat.ino = initial.ino + (scenario.differentInode ? 1n : 0n);
              return stat;
            };
            handle.readFile = async (...readArgs) => {
              targetReads++;
              return originalRead(...readArgs);
            };
            handle.close = async (...closeArgs) => {
              closes++;
              return originalClose(...closeArgs);
            };
          }
          return handle;
        });
        // Only Windows metadata semantics are simulated. The file and read-only flags stay native.
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        const accepted = scenario.accepted.includes('win32');
        if (accepted) {
          assert.equal((await readLocatedRuntimeFile(target, new Set(), 1024)).toString('utf8'), '{"fixture":"foreign volume identity"}');
        } else {
          await assert.rejects(readLocatedRuntimeFile(target, new Set(), 1024), error => {
            assert.equal(error.code, 'foreign-history-changed');
            assert.equal(error.status, 'unavailable');
            return true;
          });
        }
        assert.ok(pathnameStats > 0, 'exercise the pathname identity snapshot');
        assert.ok(descriptorStats > 0, 'exercise the opened descriptor identity snapshot');
        assert.equal(targetReads, accepted ? 1 : 0, 'reject a mismatched identity before reading content');
        assert.equal(closes, 1, 'close the descriptor on both accepted and rejected reads');
      } finally {
        Object.defineProperty(process, 'platform', platform);
        sub.mock.restoreAll();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const claims = require(path.join(
  process.cwd(),
  'dist/extension/backend/reliableKernel/runtimeClaimPrimitives.js'
));

const windowsOnly = { skip: process.platform !== 'win32' };
const recordName = 'owner.json';

function parseOwner(value) {
  return value && typeof value.ownerToken === 'string' ? value : undefined;
}

function invalid(cause) {
  return Object.assign(new Error('invalid claim'), { cause });
}

function mismatch() {
  return Object.assign(new Error('claim owner changed'), { code: 'claim-mismatch' });
}

function renameBusy(source, destination) {
  return Object.assign(
    new Error(`EPERM: operation not permitted, rename '` + source + `' -> '` + destination + `'`),
    { code: 'EPERM', syscall: 'rename', path: source, dest: destination }
  );
}

async function writeClaim(claimPath, ownerToken) {
  await fsp.mkdir(claimPath, { recursive: true });
  await fsp.writeFile(path.join(claimPath, recordName), JSON.stringify({ ownerToken }) + '\n', 'utf8');
}

test('Windows Runtime claim release retries the exact transient rename failure', windowsOnly, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-claim-release-'));
  const claimPath = path.join(root, 'runtime-admission');
  const ownerToken = 'release-owner';
  const originalRename = fsp.rename;
  let injected = 0;
  try {
    await writeClaim(claimPath, ownerToken);
    fsp.rename = async (source, destination) => {
      if (source === claimPath && injected < 3) {
        injected += 1;
        throw renameBusy(source, destination);
      }
      return originalRename(source, destination);
    };

    await claims.releaseClaimRecord(
      claimPath,
      recordName,
      ownerToken,
      parseOwner,
      invalid,
      mismatch
    );

    assert.equal(injected, 3);
    await assert.rejects(fsp.stat(claimPath), { code: 'ENOENT' });
    assert.deepEqual(await fsp.readdir(root), []);
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Windows Runtime claim release revalidates owner before a retry', windowsOnly, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-claim-fence-'));
  const claimPath = path.join(root, 'runtime-admission');
  const ownerToken = 'stale-owner';
  const replacementToken = 'replacement-owner';
  const originalRename = fsp.rename;
  let injected = false;
  try {
    await writeClaim(claimPath, ownerToken);
    fsp.rename = async (source, destination) => {
      if (source === claimPath && !injected) {
        injected = true;
        await fsp.writeFile(
          path.join(claimPath, recordName),
          JSON.stringify({ ownerToken: replacementToken }) + '\n',
          'utf8'
        );
        throw renameBusy(source, destination);
      }
      return originalRename(source, destination);
    };

    await assert.rejects(
      claims.releaseClaimRecord(
        claimPath,
        recordName,
        ownerToken,
        parseOwner,
        invalid,
        mismatch
      ),
      { code: 'claim-mismatch' }
    );
    assert.equal(
      JSON.parse(await fsp.readFile(path.join(claimPath, recordName), 'utf8')).ownerToken,
      replacementToken
    );
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('released generation cleanup cannot fail an already completed claim release', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-claim-cleanup-'));
  const claimPath = path.join(root, 'runtime-admission');
  const ownerToken = 'cleanup-owner';
  const releasedPath = claims.claimGenerationPath(claimPath, 'released-' + ownerToken);
  const originalRm = fsp.rm;
  let injected = false;
  try {
    await writeClaim(claimPath, ownerToken);
    fsp.rm = async (target, options) => {
      if (target === releasedPath && !injected) {
        injected = true;
        throw Object.assign(new Error('EPERM: operation not permitted, rmdir'), {
          code: 'EPERM', syscall: 'rmdir', path: target
        });
      }
      return originalRm(target, options);
    };

    await claims.releaseClaimRecord(
      claimPath,
      recordName,
      ownerToken,
      parseOwner,
      invalid,
      mismatch
    );

    assert.equal(injected, true);
    await assert.rejects(fsp.stat(claimPath), { code: 'ENOENT' });
    assert.equal((await fsp.stat(releasedPath)).isDirectory(), true);
  } finally {
    fsp.rm = originalRm;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Windows Runtime claim release stops after the bounded retry window', windowsOnly, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-claim-persistent-'));
  const claimPath = path.join(root, 'runtime-admission');
  const ownerToken = 'persistent-owner';
  const originalRename = fsp.rename;
  let calls = 0;
  try {
    await writeClaim(claimPath, ownerToken);
    fsp.rename = async (source, destination) => {
      if (source === claimPath) {
        calls += 1;
        throw renameBusy(source, destination);
      }
      return originalRename(source, destination);
    };

    await assert.rejects(claims.releaseClaimRecord(
      claimPath,
      recordName,
      ownerToken,
      parseOwner,
      invalid,
      mismatch
    ), { code: 'EPERM' });
    assert.equal(calls, 100);
    assert.equal((await fsp.stat(claimPath)).isDirectory(), true);
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Runtime claim does not retry an unrelated rename error', windowsOnly, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-claim-unrelated-'));
  const claimPath = path.join(root, 'runtime-admission');
  const ownerToken = 'unrelated-owner';
  const originalRename = fsp.rename;
  let calls = 0;
  try {
    await writeClaim(claimPath, ownerToken);
    fsp.rename = async (source, destination) => {
      if (source === claimPath) {
        calls += 1;
        throw Object.assign(renameBusy(source, destination), { dest: destination + '.different' });
      }
      return originalRename(source, destination);
    };

    await assert.rejects(claims.releaseClaimRecord(
      claimPath,
      recordName,
      ownerToken,
      parseOwner,
      invalid,
      mismatch
    ), { code: 'EPERM' });
    assert.equal(calls, 1);
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(root, { recursive: true, force: true });
  }
});


test('Windows Runtime claim publication and dead-owner isolation share bounded rename recovery', windowsOnly, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-claim-other-renames-'));
  const publicationPath = path.join(root, 'publication-admission');
  const isolationPath = path.join(root, 'isolation-admission');
  const isolatedGeneration = claims.claimGenerationPath(isolationPath, 'dead-dead-owner');
  const originalRename = fsp.rename;
  let publicationErrors = 0;
  let isolationErrors = 0;
  try {
    fsp.rename = async (source, destination) => {
      if (destination === publicationPath && String(source).startsWith(publicationPath + '.candidate-') && publicationErrors < 2) {
        publicationErrors += 1;
        throw renameBusy(source, destination);
      }
      if (source === isolationPath && destination === isolatedGeneration && isolationErrors < 2) {
        isolationErrors += 1;
        throw renameBusy(source, destination);
      }
      return originalRename(source, destination);
    };

    assert.equal(await claims.tryPublishClaimRecord(
      publicationPath,
      recordName,
      JSON.stringify({ ownerToken: 'publication-owner' }) + '\n'
    ), true);
    await writeClaim(isolationPath, 'dead-owner');
    await claims.isolateDeadClaimRecord(
      isolationPath,
      recordName,
      'dead-owner',
      parseOwner,
      invalid
    );

    assert.equal(publicationErrors, 2);
    assert.equal(isolationErrors, 2);
    assert.equal((await fsp.stat(publicationPath)).isDirectory(), true);
    await assert.rejects(fsp.stat(isolationPath), { code: 'ENOENT' });
    assert.equal((await fsp.stat(isolatedGeneration)).isDirectory(), true);
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Runtime holder inspection explains why an owner is unknown', () => {
  const invalidPid = claims.inspectRecordedProcess(-1, undefined);
  assert.equal(invalidPid.state, 'unknown');
  assert.match(invalidPid.reason, /not a valid pid/);

  const self = claims.inspectRecordedProcess(process.pid, claims.ownProcessStartIdentity());
  assert.equal(self.state, 'alive');
  assert.equal(self.reason, undefined);
});

function systemProcessCreationTicks() {
  // PID 4 is the Windows System process: Get-Process cannot read its StartTime even when elevated,
  // while Win32_Process.CreationDate can — the same split as services, lsass or antivirus for a
  // non-elevated VS Code, which is how a reused-pid holder left stale claims unverifiable.
  const { resolveWindowsPowerShell } = require(path.join(
    process.cwd(),
    'dist/extension/backend/capabilities/windowsPowerShell.js'
  ));
  const output = require('node:child_process').execFileSync(resolveWindowsPowerShell().executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter 'ProcessId=4').CreationDate.ToUniversalTime().Ticks"
  ], { encoding: 'utf8', windowsHide: true });
  return BigInt(output.trim());
}

test('Windows creation-time fallback never reports a live process as reused', windowsOnly, () => {
  const protocol = require(path.join(process.cwd(), 'dist/extension/backend/reliableKernel/processProtocol.js'));
  const self = protocol.checkWindowsStartIdentityByCreationTime(process.pid, claims.ownProcessStartIdentity());
  assert.equal(self.verdict, 'inconclusive', self.detail);
  const system = protocol.checkWindowsStartIdentityByCreationTime(4, `win32-process:4:${systemProcessCreationTicks()}`);
  assert.equal(system.verdict, 'inconclusive', system.detail);
  assert.equal(protocol.checkWindowsStartIdentityByCreationTime(4, 'win32-process:5:1').verdict, 'inconclusive');
  assert.equal(protocol.checkWindowsStartIdentityByCreationTime(4, 'linux-proc:4:1').verdict, 'inconclusive');
});

test('Windows holder inspection proves a protected reused pid dead and keeps a matching one unknown', windowsOnly, () => {
  const reused = claims.inspectRecordedProcess(4, 'win32-process:4:0');
  assert.equal(reused.state, 'dead', reused.reason);

  const matching = claims.inspectRecordedProcess(4, `win32-process:4:${systemProcessCreationTicks()}`);
  assert.equal(matching.state, 'unknown');
  assert.match(matching.reason, /start time could not be read.*matches the recorded start within tolerance/);

  const unrecorded = claims.inspectRecordedProcess(4, undefined);
  assert.notEqual(unrecorded.state, 'dead');
});

test('Windows admission takes over a stale claim whose pid was reused by a protected process', windowsOnly, async () => {
  const hostControl = require(path.join(process.cwd(), 'dist/extension/backend/reliableKernel/runtimeHostControl.js'));
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-admission-reused-pid-'));
  try {
    const configurationRoot = path.join(root, 'globalStorage', 'publisher.extension');
    const claimPath = hostControl.runtimeDataRootAdmissionClaimPath(configurationRoot);
    const writeStale = async (processStartIdentity) => {
      await fsp.mkdir(claimPath, { recursive: true });
      await fsp.writeFile(path.join(claimPath, recordName), JSON.stringify({
        claimToken: `stale-${processStartIdentity}`,
        processId: 4,
        processStartIdentity,
        startedAt: new Date(0).toISOString(),
        rootPointerPath: configurationRoot
      }) + '\n', 'utf8');
    };

    await writeStale('win32-process:4:0');
    let entered = false;
    await hostControl.withRuntimeDataRootAdmission(configurationRoot, async () => { entered = true; });
    assert.equal(entered, true);
    await assert.rejects(fsp.lstat(claimPath), { code: 'ENOENT' });

    await writeStale(`win32-process:4:${systemProcessCreationTicks()}`);
    await assert.rejects(
      hostControl.withRuntimeDataRootAdmission(configurationRoot, async () => undefined),
      (error) => hostControl.isRuntimeMaintenanceBusyError(error) && /within tolerance/.test(error.message)
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Runtime maintenance busy error carries the probe failure reason', () => {
  const hostControl = require(path.join(process.cwd(), 'dist/extension/backend/reliableKernel/runtimeHostControl.js'));
  const error = new hostControl.RuntimeMaintenanceBusyError('claim-path', {
    claimToken: 'token', processId: 5000, startedAt: new Date(0).toISOString(), rootPointerPath: 'root'
  }, 'PowerShell probe timed out 3 times');
  assert.equal(error.reason, 'PowerShell probe timed out 3 times');
  assert.match(error.message, /holder process 5000 for claim-path \(PowerShell probe timed out 3 times\)/);
  assert.ok(hostControl.isRuntimeMaintenanceBusyError(error));
});

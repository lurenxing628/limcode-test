// Child process for runtime-dataset-merge.test.mjs: a second window on the same selected data set.
//   kill <root> <point> [candidateId]   merge online and SIGKILL itself at a durable boundary
//   writer <root> <stopFile> <resultFile> <mergedConversationId>
//                                       write conversations until stopFile exists (resultFile.ready
//                                       after the first commit), then report what it saw
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
const [mode, root, ...rest] = process.argv.slice(2);
const NOW = '2026-09-26T00:00:00.000Z';

const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `child-${process.pid}` });
if (mode === 'kill') {
  const [point, candidateId] = rest;
  const report = await mergeHistoricalDataSetsOnline({ globalStoragePath: root }, { configurationRootPath: root, database }, {
    ...(candidateId ? { candidateIds: [candidateId] } : {}),
    onFaultPoint(reached) { if (reached === point) process.kill(process.pid, 'SIGKILL'); }
  });
  process.stderr.write(`not killed: ${JSON.stringify(report)}\n`);
  process.exit(3);
}
if (mode === 'writer') {
  const [stopFile, resultFile, mergedConversationId] = rest;
  let written = 0;
  const errors = [];
  for (;;) {
    try {
      await database.transaction([kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: `peer_conversation_${written}`, title: 'peer', status: 'active', created_at: NOW, updated_at: NOW
      })]);
      written += 1;
      if (written === 1) await fs.writeFile(`${resultFile}.ready`, '');
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
    if (await fs.stat(stopFile).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const seen = (await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(mergedConversationId)])).snapshot[0];
  await database.close();
  await fs.writeFile(resultFile, JSON.stringify({ written, errors, sawMerged: seen !== null }));
  process.exit(0);
}
process.exit(2);

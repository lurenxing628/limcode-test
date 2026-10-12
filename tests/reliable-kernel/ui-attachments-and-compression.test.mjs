import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';
import { kernel, readFileTool, createLlmProviderCapability, expandTextCompressionSources,
  createAttachmentCompressionFixture, compactRequest, compact, deferred, SUMMARY, IMAGE, words } from './ui-attachments-and-compression-fixture.mjs';

let h, ssr, vue, ImageView, RebuildConfirm, bridgeTypes;
const previousWindow = globalThis.window;
const posted = [], listeners = new Set();
before(async () => { h = await createAttachmentCompressionFixture(); });
after(async () => { await ssr?.close(); globalThis.window = previousWindow; await h?.close(); });

async function webview() {
  if (ssr) return;
  globalThis.window = {
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() {}, setState() {} }; }
  };
  ssr = await createWebviewSsrServer(); vue = await import('vue');
  ImageView = (await ssr.ssrLoadModule('/src/components/content/parts/InlineDataPartView.vue')).default;
  RebuildConfirm = (await ssr.ssrLoadModule('/src/components/input/SummaryRebuildConfirm.vue')).default;
  ({ BridgeMessageType: bridgeTypes } = await ssr.ssrLoadModule('/@fs' + process.cwd() + '/shared/protocol.ts'));
}
const toolContext = multimodal => ({ settingsSnapshot: { enableMultimodalTools: multimodal }, emit() {} });
const attachmentContent = (name, data = IMAGE) => JSON.stringify({ role: 'user', parts: [
  { text: `Original ${name}` }, { inlineData: { name, mimeType: 'image/png', data: data.toString('base64'), storage: 'embedded' } }
] });
const catalogAt = async (conversationId, rootId) => {
  const structure = await h.app.context.materializeStructure(rootId);
  return h.app.modelProvider.projectAttachmentCatalogState(conversationId, structure.records.map(({ segment }) => ({ segmentId: segment.id })));
};
const sourceItems = async rootId => (await h.app.context.materialize(rootId)).segments.map(segment => ({
  segmentId: segment.segmentId, segmentKind: segment.segmentKind, messageRole: segment.messageRole,
  contentType: segment.contentObject.content_type, content: segment.content.toString('utf8')
}));

test('20 MiB 实际进入 CAS，超限先拒绝，重复本地 occurrence 只读一次且保存原字节', async t => {
  const size = 20 * 1024 * 1024;
  const exact = await h.app.attachments.prepareValueAttachments({ inlineData: {
    mimeType: 'application/octet-stream', name: 'limit.bin', data: Buffer.alloc(size, 0x6d).toString('base64'), storage: 'embedded' } });
  await h.app.database.transaction(exact.storageSteps);
  assert.equal(exact.totalBytes, size);
  const [attachment] = await h.list('Attachment', { id: exact.attachments[0].attachmentId });
  const [metadata] = await h.list('ContentObject', { id: attachment.content_object_id });
  assert.equal(metadata.byte_length, BigInt(size));
  const persisted = await h.app.contentStore.readChunk(metadata, size - 16, 16);
  assert.equal(persisted.totalBytes, size); assert.equal(persisted.hasMore, false);
  assert.deepEqual(persisted.chunk, Buffer.alloc(16, 0x6d));
  const prepare = h.app.contentStore.prepareIdentifiedBatch.bind(h.app.contentStore);
  let preparations = 0;
  t.mock.method(h.app.contentStore, 'prepareIdentifiedBatch', (...args) => { preparations += 1; return prepare(...args); });
  await assert.rejects(h.app.attachments.prepareValueAttachments({ inlineData: {
    mimeType: 'application/octet-stream', name: 'over.bin', data: 'A'.repeat(Math.ceil((size + 1) / 3) * 4), storage: 'embedded' } }),
  error => error.name === 'AttachmentSizeLimitError');
  assert.equal(preparations, 0);
  const file = path.join(h.directory, 'same.txt'), original = '不可变的中文附件 😀';
  await fs.writeFile(file, original);
  const read = fs.readFile.bind(fs); let reads = 0;
  t.mock.method(fs, 'readFile', (target, ...args) => { if (target === file) reads += 1; return read(target, ...args); });
  const part = { inlineData: { sourcePath: file, storage: 'localPath', mimeType: 'text/plain', name: 'same.txt' } };
  const repeated = await h.app.attachments.prepareValueAttachments({ parts: [part, part] });
  assert.equal(reads, 1); assert.equal(repeated.attachments.length, 2);
  assert.equal(repeated.attachments[0].attachmentId, repeated.attachments[1].attachmentId);
  await h.app.database.transaction(repeated.storageSteps); await fs.writeFile(file, 'later external edit');
  assert.equal(Buffer.from((await h.app.attachments.resolveInlineData(repeated.attachments[0].attachmentId)).inlineData.data, 'base64').toString(), original);
});

test('实际 PDF 只复制所选页并给下一范围，图片保持整幅并拒绝分页参数', async () => {
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 6; page++) pdf.addPage([600 + page, 800]);
  const source = await h.admit(Buffer.from(await pdf.save()), 'application/pdf', 'source.pdf');
  const result = await readFileTool.execute({ attachmentId: source.inlineData.attachmentId, pages: '2-5' }, h.readDependencies, toolContext(true));
  assert.equal(result.ok, true); assert.equal(result.output.nextPages, '6'); assert.equal(result.output.totalPages, 6);
  const selected = await PDFDocument.load(Buffer.from(result.parts[0].inlineData.data, 'base64'));
  assert.deepEqual(selected.getPages().map(page => page.getWidth()), [602, 603, 604, 605]);
  const image = await h.admit(IMAGE, 'image/png', 'whole.png');
  const whole = await readFileTool.execute({ attachmentId: image.inlineData.attachmentId }, h.readDependencies, toolContext(true));
  assert.deepEqual(whole.parts, [image]);
  const paged = await readFileTool.execute({ attachmentId: image.inlineData.attachmentId, pages: '1' }, h.readDependencies, toolContext(true));
  assert.equal(paged.ok, false); assert.match(String(paged.output), /not supported for image/);
});

test('真实 UTF-8 TXT 有界分页无损拼接，文本读取不要求 multimodal', async () => {
  const text = `开头\n${'中文😀\\quote"\n'.repeat(2300)}末尾`, chunks = [];
  const part = await h.admit(Buffer.from(text), 'text/plain', 'utf8.txt');
  let pages = '1', total;
  do {
    const result = await readFileTool.execute({ attachmentId: part.inlineData.attachmentId, pages }, h.readDependencies, toolContext(false));
    assert.equal(result.ok, true); assert.equal(result.parts, undefined);
    assert.ok(result.output.content.length <= 8192); assert.equal(result.output.content.includes('\uFFFD'), false);
    chunks.push(result.output.content); total ??= result.output.totalPages; pages = result.output.nextPages;
  } while (pages);
  assert.ok(total >= 3); assert.equal(chunks.length, total); assert.equal(chunks.join(''), text);
});

test('压缩后分支从确切来源重建附件目录并保留原 F 句柄', async () => {
  const source = await h.seed('attachment-lineage', attachmentContent('lineage.png'), false, 'application/vnd.limcode.message+json');
  const original = await catalogAt(source.conversationId, source.rootId);
  const handles = await h.app.modelProvider.ensureAttachmentHandles(source.conversationId, original.catalog);
  const compressed = await h.app.compression.create({ conversationId: source.conversationId, headRootId: source.rootId,
    authoritySnapshotId: source.authoritySnapshotId, compressSegmentCount: 1, title: '附件摘要',
    idempotencyKey: 'attachment-lineage-summary', summary: [{ role: 'user', parts: [{ text: 'Preserved F1.' }] }] });
  const continued = await h.app.agentLoop.runInput({ source: { kind: 'command', key: 'attachment-lineage-tail' }, conversationId: source.conversationId,
    leaseOwnerId: 'ui-compression-owner', hostBootId: h.app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    content: 'Continue from the preserved image.' });
  assert.equal(continued.terminalStatus, 'completed');
  const members = await h.list('MessagePartOfConversation', { conversation_id: source.conversationId });
  const latest = members.sort((a, b) => Number(b.message_seq - a.message_seq))[0];
  const [current] = await h.list('MessageCurrentRevisionLink', { message_id: latest.message_id });
  const [boundary] = await h.list('ContextSegmentSource', { source_kind: 'message_revision', source_id: current.revision_id });
  const fork = await h.app.runtime.conversationFork.fork({ idempotencyKey: 'attachment-lineage-fork', reuseKey: 'attachment-lineage-fork',
    sourceConversationId: source.conversationId, sourceContextRootId: await h.app.context.currentHeadRootId(source.conversationId),
    sourceContextEndSegmentId: boundary.segment_id,
    sourceMessageRevisionId: current.revision_id, expectedCurrentMessageRevisionId: current.revision_id, sourceTurnId: continued.turnId,
    targetAgentId: h.agent.id, targetTitle: '分支' });
  const projected = await catalogAt(fork.targetConversationId, fork.targetRootId);
  assert.deepEqual(projected.catalog, original.catalog);
  const forkHandles = await h.app.modelProvider.ensureAttachmentHandles(fork.targetConversationId, projected.catalog);
  assert.deepEqual(forkHandles.entries.map(({ target, ref }) => [target, ref]), handles.entries.map(({ target, ref }) => [target, ref]));
  const expanded = await expandTextCompressionSources(h.app.database, h.app.contentStore, fork.targetConversationId,
    await sourceItems(fork.targetRootId), { sourceReplay: 'immutable_provenance' });
  assert.ok(expanded.some(item => item.content.includes('Original lineage.png')));
  assert.ok(expanded.some(item => item.content.includes(original.catalog[0].attachmentId)));
  assert.equal((await h.list('ConversationBranchLink', { target_conversation_id: fork.targetConversationId }))[0].source_conversation_id, source.conversationId);
  const rebuilt = await h.app.compression.create({ conversationId: fork.targetConversationId, headRootId: fork.targetRootId,
    authoritySnapshotId: (await h.list('CompressionBlock', { conversation_id: fork.targetConversationId }))[0].authority_snapshot_id,
    compressSegmentCount: 1, title: '重建', idempotencyKey: 'attachment-lineage-rebuilt',
    summary: [{ role: 'user', parts: [{ text: 'Rebuilt from original F1.' }] }] });
  assert.deepEqual((await catalogAt(fork.targetConversationId, rebuilt.rootId)).catalog, original.catalog);
});

test('不可用媒体保持未知，provider 实际观察恢复后复用且旧历史保持原字节', async () => {
  const history = await h.seed('observation-lifecycle', 'Preserve F1 evidence.');
  const part = await h.admit(IMAGE, 'image/png', 'observed.png'), data = part.inlineData;
  const catalog = [{ attachmentId: data.attachmentId, name: data.name, mimeType: data.mimeType, sizeBytes: data.sizeBytes }];
  const handles = { entries: [{ kind: 'attachment', ref: 'F1', target: data.attachmentId, ...catalog[0] }] }, profile = 'd'.repeat(64);
  const recovered = { attachmentRef: 'F1', summary: 'A one-pixel status indicator.', salientFacts: ['The status is visible.'], uncertainties: [] };
  let available = false, observations = 0;
  h.state.reply = (record, response) => {
    if (!record.text.includes('Attachment observation contract revision')) return SUMMARY;
    observations += 1;
    if (!available) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Unsupported image', type: 'invalid_request_error' } })); return; }
    return JSON.stringify(recovered);
  };
  const capability = createLlmProviderCapability(h.providerOptions());
  const load = () => kernel.loadAttachmentObservationRequirements(h.app.database, h.app.contentStore, catalog, handles, profile);
  async function perform(id) {
    const requirements = await load(), request = compactRequest(id, 'Keep the actual attachment.', 'llm_summary');
    request.contents = [{ role: 'user', parts: [{ text: 'Keep F1.' }, part] }]; delete request.segments;
    request.attachmentObservationProfileSha256 = profile; request.attachmentObservationRequirements = requirements;
    const terminal = await compact(capability, request); assert.equal(terminal.type, 'llm:compactDone', JSON.stringify(terminal));
    const result = terminal.payload.result;
    const created = await h.app.compression.create({ conversationId: history.conversationId,
      headRootId: await h.app.context.currentHeadRootId(history.conversationId), authoritySnapshotId: history.authoritySnapshotId,
      compressSegmentCount: 1, title: id, idempotencyKey: id, summary: result.contents,
      attachmentObservations: kernel.completeAttachmentObservationCommits(requirements, result.attachmentObservations, profile) });
    return { created, result };
  }
  try {
    const missing = await perform('observation-missing');
    assert.equal((await load())[0].cachedObservation, undefined);
    assert.match(JSON.stringify(missing.result.contents), /not observed/);
    const [block] = await h.list('CompressionBlock', { id: missing.created.compressionBlockId });
    const [metadata] = await h.list('ContentObject', { id: block.summary_object_id });
    const oldBytes = await h.app.contentStore.read(metadata);
    available = true; await perform('observation-recovered');
    assert.deepEqual((await load())[0].cachedObservation, recovered);
    assert.deepEqual((await perform('observation-reused')).result.attachmentObservations, [recovered]);
    assert.equal(observations, 2); assert.deepEqual(await h.app.contentStore.read(metadata), oldBytes);
    assert.deepEqual(Buffer.from((await h.app.attachments.resolveInlineData(data.attachmentId)).inlineData.data, 'base64'), IMAGE);
  } finally { capability.dispose(); h.state.reply = undefined; }
});

test('托管图像自动加载，替换和卸载后迟到回执不覆盖当前显示', async t => {
  await webview();
  const image = id => ({ inlineData: { attachmentId: id, sha256: `identity-${id}`, mimeType: 'image/png', name: `${id}.png`, sizeBytes: 8, storage: 'managed', status: 'available' } });
  const part = vue.ref(image('old')), start = posted.length; let view;
  const renderer = vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode() { return null; }, nextSibling() { return null; }, insert() {}, remove() {}, patchProp() {} });
  const component = { ...ImageView, render() { return null; }, ssrRender: undefined };
  const app = renderer.createApp({ setup() { return () => vue.h(component, { part: part.value, ref: instance => { view = instance?.$?.setupState; } }); } });
  app.provide(vue.ssrContextKey, { modules: new Set() }); app.mount({}); t.after(() => app.unmount());
  const requests = () => posted.slice(start).filter(message => message.type === bridgeTypes.AttachmentReload);
  const reply = request => { for (const listener of listeners) listener({ data: { id: 'reply', type: bridgeTypes.AttachmentReloadResult,
    correlationId: request.id, payload: { part: { inlineData: { ...request.payload, data: 'YQ==', sizeBytes: 8, storage: 'managed', status: 'available' } }, status: 'available' } } }); };
  assert.equal(view.expanded, true); const old = requests()[0]; assert.ok(old);
  part.value = image('current'); await vue.nextTick(); const current = requests().at(-1);
  reply(old); assert.equal(view.dataUri, ''); reply(current); assert.equal(view.dataUri, 'data:image/png;base64,YQ==');
  part.value = image('pending'); await vue.nextTick(); const pending = requests().at(-1), removedView = view;
  app.unmount(); reply(pending); assert.equal(removedView.dataUri, '');
  const { renderToString } = await import('@vue/server-renderer');
  const html = await renderToString(vue.createSSRApp(ImageView, { part: { inlineData: { mimeType: 'image/png', data: 'YQ==', storage: 'embedded' } } }));
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YQ=="/);
});

test('过大 Unicode 回合分段压缩成功，随后只读预估与原文重建一致且 leaf 完成后才合并', async () => {
  await h.withProviderWindow(28_000, async () => {
    const text = Array.from({ length: 1100 }, (_, i) => `He said "hi" C:\\tmp\\${i}\n\t中文😀\u0001 {"k":[${i}]}\r\n`).join('');
    const history = await h.seed('unicode-rebuild', text);
    let start = h.bodies.length;
    const leavesFrom = records => records.filter(record => record.text.includes('本段历史记录'));
    const assertSource = records => {
      const leaves = leavesFrom(records), marker = '【本段历史记录】\n1. user: ';
      assert.ok(leaves.length >= 2);
      const chunks = leaves.map(record => {
        const user = record.body.messages.find(message => message.role === 'user').content;
        assert.ok(user.includes(marker)); return user.slice(user.indexOf(marker) + marker.length);
      });
      // The provider runs leaves concurrently; HTTP arrival order is not source order.
      chunks.sort((left, right) => text.indexOf(left) - text.indexOf(right));
      assert.equal(chunks.join(''), text);
      assert.ok(records.some(record => record.text.includes('新增分段摘要')));
      return leaves.length;
    };
    h.state.reply = record => {
      if (record.text.includes('新增分段摘要')) assert.ok(leavesFrom(h.bodies.slice(start)).every(leaf => leaf.done));
      return SUMMARY;
    };
    try {
      const compressed = await h.rebuild(history, 'unicode-ordinary-compression', null);
      assert.equal(compressed.compression.status, 'compressed');
      assert.deepEqual(compressed.compression.attemptedMethods, ['segmented_summary']);
      const ordinaryLeafCount = assertSource(h.bodies.slice(start));
      const current = { ...history, rootId: compressed.compression.result.rootId };
      const before = (await h.app.database.inspect()).currentCommitSeq; start = h.bodies.length;
      const preview = await h.runner.previewSourceReplayCompression({ conversationId: current.conversationId, expectedRootId: current.rootId });
      assert.equal(preview.outcome.kind, 'ready'); assert.equal(preview.outcome.summaryRequests, ordinaryLeafCount);
      assert.equal(preview.estimate.contextWindowTokens, 28_000);
      assert.ok(preview.estimate.sourceTokens > preview.estimate.inputCapacityTokens, 'one original Turn genuinely exceeds the frozen input room');
      assert.equal((await h.app.database.inspect()).currentCommitSeq, before); assert.equal(h.bodies.length, start);
      const rebuilt = await h.rebuild(current, 'unicode-source-rebuild');
      assert.equal(rebuilt.compression.status, 'compressed');
      assert.equal(assertSource(h.bodies.slice(start)), preview.outcome.summaryRequests);
      assert.equal((await h.list('ModelRequest', { turn_id: rebuilt.turnId }))[0].terminal_state, 'completed');
    } finally { h.state.reply = undefined; }
  });
});

test('超过 32 leaf 的预估和实际重建均无模型调用，root 变化也阻止确认与准入', async () => {
  await h.withProviderWindow(26_000, async () => {
    const limitHistory = await h.seed('leaf-limit', words(30_000), true);
    const sent = h.bodies.length;
    const blocked = await h.runner.previewSourceReplayCompression({ conversationId: limitHistory.conversationId, expectedRootId: limitHistory.rootId });
    assert.deepEqual(blocked.outcome, { kind: 'blocked', reason: 'leaf_budget_exceeded', leafRequestLimit: 32 });
    await webview(); const { renderToString } = await import('@vue/server-renderer');
    async function button(result, targetCurrent) {
      const context = {}; await renderToString(vue.createSSRApp(RebuildConfirm, { open: true, targetCurrent, preview: { status: 'loaded', result } }), context);
      const html = Object.values(context.teleports ?? {}).join('');
      const tag = html.match(/<button[^>]*data-testid="compression-rebuild-confirm-confirm"[^>]*>/)?.[0];
      assert.ok(tag); return tag;
    }
    assert.match(await button(blocked, true), /\sdisabled/);
    await assert.rejects(h.rebuild(limitHistory), /compression_source_too_large/);
    assert.equal(h.bodies.length, sent);
    assert.equal((await h.list('CompressionBlock', { conversation_id: limitHistory.conversationId })).length, 1);
    const moved = await h.seed('moved-preview', 'source', true);
    const ready = await h.runner.previewSourceReplayCompression({ conversationId: moved.conversationId, expectedRootId: moved.rootId });
    await h.app.context.appendContent({ conversationId: moved.conversationId, segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'moved-source', sourceRevision: '0' }, contentType: 'text/plain', content: 'Later root.' });
    assert.match(await button(ready, false), /\sdisabled/);
    await assert.rejects(h.rebuild(moved), /当前上下文已变化/); assert.equal(h.bodies.length, sent);
  });
});

test('超长摘要至多请求删短一次，实际用户取消在途压缩不提交摘要', { timeout: 10_000 }, async () => {
  const oversized = [SUMMARY, ...Array.from({ length: 200 }, (_, i) => `- src/generated/module-${i}/implementation-file-${i}.ts`)].join('\n');
  h.state.reply = () => oversized;
  const capability = createLlmProviderCapability(h.providerOptions()), start = h.bodies.length;
  try { assert.equal((await compact(capability, compactRequest('shorten-once', 'actual history '.repeat(200), 'llm_summary'))).type, 'llm:compactDone'); }
  finally { capability.dispose(); }
  assert.equal(h.bodies.slice(start).filter(record => record.text.includes('删短到约')).length, 1);
  const history = await h.seed('cancel-compression', 'actual history '.repeat(300), true), entered = deferred(), closed = deferred();
  h.state.reply = (record, response) => {
    if (!record.text.includes('删短到约')) return oversized;
    response.on('close', closed.resolve); entered.resolve(); return;
  };
  const blocksBefore = (await h.list('CompressionBlock', { conversation_id: history.conversationId })).length;
  const result = h.rebuild(history).then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    const [turn] = await h.list('Turn', { conversation_id: history.conversationId, status: 'active' }); assert.ok(turn);
    await h.runner.interrupt({ commandId: 'cancel-summary-command', conversationId: history.conversationId, turnId: turn.id, reason: '用户取消压缩' });
    await closed.promise; await result;
    assert.equal(await h.app.context.currentHeadRootId(history.conversationId), history.rootId);
    assert.equal((await h.list('CompressionBlock', { conversation_id: history.conversationId })).length, blocksBefore);
    assert.equal((await h.list('Turn', { id: turn.id }))[0].status, 'terminated');
    assert.equal((await h.list('TurnTermination', { turn_id: turn.id }))[0].terminal_status, 'interrupted');
    const requests = await h.list('ModelRequest', { turn_id: turn.id });
    assert.equal(requests.length, 1); assert.equal(requests[0].status, 'terminal'); assert.notEqual(requests[0].terminal_state, 'completed');
  } finally { h.state.reply = undefined; }
});

test('切回 Context 并 fork 后只展开当前 root 来源，丢弃的分支保留在历史但不混入', async () => {
  const history = await h.seed('selected-root', 'ORIGINAL-SELECTED-INPUT');
  const selection = { conversationId: history.conversationId, segmentKind: 'runtime_context',
    source: { sourceKind: 'runtime_context', sourceId: 'selected-suffix', sourceRevision: '0' },
    content: 'KEEP-SELECTED-SUFFIX', contentType: 'text/plain', baseRootId: history.rootId };
  const selected = await h.app.context.appendContent(selection);
  const abandoned = await h.app.context.appendContent({ conversationId: history.conversationId, segmentKind: 'runtime_context',
    source: { sourceKind: 'runtime_context', sourceId: 'abandoned-suffix', sourceRevision: '0' }, content: 'DISCARDED-BRANCH', contentType: 'text/plain' });
  await h.app.context.appendContent({ ...selection, expectedHeadRootId: abandoned.rootId });
  assert.equal(await h.app.context.currentHeadRootId(history.conversationId), selected.rootId);
  const compressed = await h.app.compression.create({ conversationId: history.conversationId, headRootId: selected.rootId,
    authoritySnapshotId: history.authoritySnapshotId, compressSegmentCount: 2, title: '选中根摘要', idempotencyKey: 'selected-summary',
    summary: [{ role: 'user', parts: [{ text: 'Selected root summary.' }] }] });
  const fork = await h.app.runtime.conversationFork.fork({ idempotencyKey: 'selected-root-fork', reuseKey: 'selected-root-fork',
    sourceConversationId: history.conversationId, sourceContextRootId: compressed.rootId, targetAgentId: h.agent.id, targetTitle: '选中分支' });
  const expanded = await expandTextCompressionSources(h.app.database, h.app.contentStore, fork.targetConversationId,
    await sourceItems(fork.targetRootId), { sourceReplay: 'immutable_provenance' });
  const text = expanded.map(item => item.content).join('\n');
  assert.match(text, /ORIGINAL-SELECTED-INPUT/); assert.match(text, /KEEP-SELECTED-SUFFIX/); assert.doesNotMatch(text, /DISCARDED-BRANCH/);
  assert.ok((await sourceItems(abandoned.rootId)).some(item => item.content.includes('DISCARDED-BRANCH')));
});

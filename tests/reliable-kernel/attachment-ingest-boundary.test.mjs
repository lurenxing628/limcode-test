import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { AttachmentIngestService } from '../../dist/extension/backend/reliableKernel/attachmentIngest.js';
import { ContentAddressedStore } from '../../dist/extension/backend/reliableKernel/contentAddressedStore.js';
import {
  collectAttachmentCatalogFromStoredItems,
  normalizeAttachmentCatalogState,
  renderAttachmentCatalog,
  renderAttachmentCatalogState
} from '../../dist/extension/backend/reliableKernel/attachmentCatalog.js';
import {
  compactReadFileToolArguments,
  readFileTool,
  readFileToolDescription,
  readFileToolParameters
} from '../../dist/extension/backend/world/modules/tools/definitions/readFile/index.js';
import {
  parseReadPageRange,
  resolveReadPageRange
} from '../../dist/extension/backend/world/modules/tools/definitions/readFile/pageRange.js';
import {
  splitReadTextPages
} from '../../dist/extension/backend/world/modules/tools/definitions/readFile/textPages.js';

const MIB = 1024 * 1024;
const ATTACHMENT_LIMIT_BYTES = 20 * MIB;

function serviceFixture() {
  let prepareBatchCalls = 0;
  let identifyCalls = 0;
  const contentStore = {
    identify(content, contentType) {
      identifyCalls += 1;
      return ContentAddressedStore.prototype.identify.call(this, content, contentType);
    },
    async prepareIdentifiedBatch(_database, inputs) {
      prepareBatchCalls += 1;
      return inputs.map(({ identity }) => ({
        metadata: {
          ...identity,
          created_at: '2026-01-01T00:00:00.000Z'
        }
      }));
    }
  };
  const settingsAuthority = {
    async loadGlobalSettings(section) {
      assert.equal(section, 'attachments');
      return {
        section,
        settings: { maxStoredInlineFileMb: 20 },
        filePath: 'settings/attachments.json'
      };
    }
  };
  return {
    service: new AttachmentIngestService({}, contentStore, settingsAuthority),
    prepareBatchCalls: () => prepareBatchCalls,
    identifyCalls: () => identifyCalls
  };
}

function inlineAttachment(data, sizeBytes = undefined) {
  return {
    ok: true,
    parts: [{
      inlineData: {
        mimeType: 'image/png',
        name: 'twenty-megabytes.png',
        data,
        storage: 'embedded',
        status: 'available',
        ...(sizeBytes === undefined ? {} : { sizeBytes })
      }
    }]
  };
}

async function createPdfBytes(pageCount) {
  const pdf = await PDFDocument.create();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    pdf.addPage([600 + pageNumber, 800]);
  }
  return Buffer.from(await pdf.save());
}

test('AttachmentIngest accepts an exact 20 MiB embedded attachment and externalizes it', async () => {
  const { service, prepareBatchCalls } = serviceFixture();
  const bytes = Buffer.alloc(ATTACHMENT_LIMIT_BYTES, 0x6d);
  const admission = await service.prepareValueAttachments(
    inlineAttachment(bytes.toString('base64'), bytes.byteLength),
    '20 MiB attachment'
  );

  assert.equal(admission.totalBytes, ATTACHMENT_LIMIT_BYTES);
  assert.equal(admission.attachments.length, 1);
  assert.equal(admission.attachments[0].sizeBytes, ATTACHMENT_LIMIT_BYTES);
  assert.equal(admission.value.parts[0].inlineData.data, undefined);
  assert.equal(admission.value.parts[0].inlineData.storage, 'managed');
  assert.equal(prepareBatchCalls(), 1);
});

test('one attachment admission identifies repeated embedded bytes once and keeps every occurrence', async () => {
  const { service, identifyCalls } = serviceFixture();
  const source = inlineAttachment(Buffer.from('one immutable attachment').toString('base64'));
  const admission = await service.prepareValueAttachments({ parts: [source.parts[0], source.parts[0]] });
  assert.equal(identifyCalls(), 1);
  assert.equal(admission.attachments.length, 2);
  assert.deepEqual(admission.attachments.map(({ position }) => position), ['0', '1']);
  assert.equal(admission.attachments[0].attachmentId, admission.attachments[1].attachmentId);
  assert.ok(admission.attachments.every(reference => !('identified' in reference) && !('prepared' in reference)));
});

test('concurrent local-path occurrences join one file read and enter CAS without a base64 round trip', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-attachment-flight-'));
  const target = path.join(parent, 'same-file.txt');
  await fs.writeFile(target, 'shared local attachment');
  const originalRead = fs.readFile;
  let reads = 0;
  context.mock.method(fs, 'readFile', async function (file, ...args) {
    if (file === target) reads += 1;
    return originalRead.call(this, file, ...args);
  });
  try {
    const { service, identifyCalls } = serviceFixture();
    const part = { inlineData: { sourcePath: target, storage: 'localPath', mimeType: 'text/plain', name: 'same-file.txt' } };
    const admission = await service.prepareValueAttachments({ parts: [part, part, part] });
    assert.equal(reads, 1);
    assert.equal(identifyCalls(), 1);
    assert.equal(admission.attachments.length, 3);
    assert.ok(admission.value.parts.every(({ inlineData }) => inlineData.storage === 'managed'
      && inlineData.data === undefined && inlineData.sourcePath === undefined));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('resolving an attachment reuses one metadata row and still rejects a conflicting CAS identity', async () => {
  const attachment = { id: 'attachment', storage_mode: 'cas', content_object_id: 'content',
    sha256: 'digest', byte_length: 5n, mime_type: 'text/plain', name: 'five.txt' };
  const content = { id: 'content', sha256: 'digest', byte_length: 5n };
  const reads = [];
  let bodyReads = 0;
  const service = new AttachmentIngestService({
    async snapshot(queries) {
      reads.push(...queries.map(query => query.domain));
      return { snapshot: queries.map(query => query.domain === 'Attachment' ? attachment : content) };
    }
  }, { async read() { bodyReads += 1; return Buffer.from('hello'); } }, {});
  const [first, second] = await Promise.all([
    service.resolveInlineData('attachment'),
    service.resolveInlineData('attachment')
  ]);
  assert.equal(first.inlineData.data, Buffer.from('hello').toString('base64'));
  assert.equal(second.inlineData.data, Buffer.from('hello').toString('base64'));
  assert.deepEqual(reads, ['Attachment', 'ContentObject']);
  content.sha256 = 'different';
  await assert.rejects(service.resolveInlineData('attachment'), /does not match its immutable metadata/);
  assert.equal(bodyReads, 1);
});

test('AttachmentIngest rejects encoded data over 20 MiB before CAS preparation', async () => {
  const { service, prepareBatchCalls } = serviceFixture();
  const oversizedCanonicalLength = Math.ceil((ATTACHMENT_LIMIT_BYTES + 1) / 3) * 4;
  const oversized = 'A'.repeat(oversizedCanonicalLength);

  await assert.rejects(
    service.prepareValueAttachments(inlineAttachment(oversized), 'oversized attachment'),
    (error) => error?.name === 'AttachmentSizeLimitError'
      && /20971520 byte limit/.test(error.message)
  );
  assert.equal(prepareBatchCalls(), 0);
});

test('Attachment catalog keeps only lightweight immutable metadata across message, tool and compression envelopes', () => {
  const first = {
    attachmentId: 'attachment-pdf-one',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 42_000
  };
  const second = {
    attachmentId: 'attachment-image-two',
    name: 'diagram.png',
    mimeType: 'image/png',
    sizeBytes: 8_192
  };
  const items = [
    {
      contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({
        role: 'user',
        parts: [{ inlineData: {
          ...first,
          sha256: 'a'.repeat(64),
          sourcePath: '/private/report.pdf',
          data: Buffer.from('must-not-enter-catalog').toString('base64'),
          storage: 'managed'
        } }]
      })
    },
    {
      contentType: 'application/vnd.limcode.context-tool-pair+json',
      content: JSON.stringify({
        kind: 'tool_pair',
        toolModelResult: {
          result: JSON.stringify({ ok: true, detail: { parts: [{ inlineData: {
            ...second,
            sha256: 'b'.repeat(64),
            storage: 'managed'
          } }] } })
        }
      })
    },
    {
      contentType: 'application/vnd.limcode.compression-contents+json',
      content: JSON.stringify({
        kind: 'compression_contents',
        version: 1,
        contents: [{ role: 'model', parts: [{ text: 'summary' }] }]
      })
    }
  ];

  const catalog = collectAttachmentCatalogFromStoredItems(items);
  assert.deepEqual(catalog, [first, second]);
  const rendered = renderAttachmentCatalog(catalog);
  assert.ok(rendered);
  const text = rendered.parts[0].text;
  assert.match(text, /read/);
  assert.match(text, /\{"attachmentRef":"F1"/);
  assert.match(text, /\{"attachmentRef":"F2"/);
  assert.match(text, /"pages":"1-4"/);
  assert.match(text, /每次最多连续读取 4 页/);
  assert.doesNotMatch(text, /"mode":"attachment"/);
  assert.match(text, /report\.pdf/);
  assert.match(text, /diagram\.png/);
  assert.doesNotMatch(text, /attachment-pdf-one|attachment-image-two/);
  assert.doesNotMatch(text, /sha256|sourcePath|private|must-not-enter-catalog|data/);
});

test('attachment catalog state rejects tail drift and unavailable placement anchors', () => {
  const entry = {
    attachmentId: 'attachment-state-one',
    name: 'state.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 42
  };
  const state = normalizeAttachmentCatalogState({
    catalog: [entry],
    placements: [{
      kind: 'attachment_catalog_delta',
      afterSegmentId: 'segment-state-one',
      entries: [entry]
    }]
  });
  assert.deepEqual(state.catalog, [entry]);
  assert.throws(
    () => normalizeAttachmentCatalogState({ catalog: [entry], placements: [] }),
    /do not reconstruct/
  );
  assert.throws(
    () => normalizeAttachmentCatalogState({
      catalog: [entry],
      placements: [
        { kind: 'attachment_catalog_delta', afterSegmentId: 'segment-state-one', entries: [entry] },
        { kind: 'attachment_catalog_delta', afterSegmentId: 'segment-state-two', entries: [entry] }
      ]
    }),
    /repeats active attachment/
  );
  assert.throws(
    () => renderAttachmentCatalogState(state, ['another-segment']),
    /unavailable ContextSegment/
  );
});

test('stored managed attachment metadata fails closed after JSON parsing', () => {
  const stored = (inlineData) => [{
    contentType: 'application/json',
    content: JSON.stringify({ parts: [{ inlineData }] })
  }];
  assert.throws(
    () => collectAttachmentCatalogFromStoredItems(stored({ attachmentId: 'attachment-missing-name' })),
    /inlineData.name must be non-empty text/
  );
  assert.throws(
    () => collectAttachmentCatalogFromStoredItems([{
      contentType: 'application/json',
      content: JSON.stringify({ result: JSON.stringify({
        parts: [{ inlineData: { attachmentId: 'attachment-nested-missing-name' } }]
      }) })
    }]),
    /inlineData.name must be non-empty text/
  );
  assert.throws(
    () => collectAttachmentCatalogFromStoredItems(stored({
      attachmentId: 'attachment-invalid-size',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: -1
    })),
    /inlineData.sizeBytes must be a non-negative safe integer/
  );
  assert.throws(
    () => collectAttachmentCatalogFromStoredItems([
      ...stored({
        attachmentId: 'attachment-drift',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10
      }),
      ...stored({
        attachmentId: 'attachment-drift',
        name: 'renamed.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10
      })
    ]),
    /metadata changed for immutable attachment attachment-drift/
  );
  assert.deepEqual(collectAttachmentCatalogFromStoredItems([{
    contentType: 'application/json',
    content: '{not-json'
  }]), []);
});

test('read keeps path as the ordinary input and only exposes pages for managed TXT/PDF', () => {
  const ordinary = readFileToolParameters(false, false);
  assert.equal(ordinary.required, undefined);
  assert.equal(Object.keys(ordinary.properties)[0], 'path');
  assert.equal(ordinary.properties.attachmentId, undefined);
  assert.equal(ordinary.properties.pages, undefined);
  assert.doesNotMatch(readFileToolDescription(false, false), /attachmentId/);

  const imageOnly = readFileToolParameters(true, false);
  assert.match(imageOnly.properties.attachmentId.description, /Rare optional input/);
  assert.equal(imageOnly.properties.pages, undefined);
  assert.doesNotMatch(readFileToolDescription(true, false), /nextPages/);

  const withPagedAttachments = readFileToolParameters(true, true);
  assert.match(withPagedAttachments.properties.pages.description, /"N" or "N-M"/);
  assert.match(readFileToolDescription(true, true), /at most 4 consecutive pages/);
  assert.match(readFileToolDescription(true, true), /exact non-empty attachmentId from that catalog/);
  assert.deepEqual(compactReadFileToolArguments({
    attachmentId: '',
    endLine: 0,
    items: [],
    mode: 'text',
    pages: '',
    path: 'src\\demo.ts',
    startLine: 0
  }), { path: 'src/demo.ts', mode: 'text', startLine: 0, endLine: 0 });
  assert.deepEqual(compactReadFileToolArguments({
    attachmentId: ' attachment-one ',
    endLine: 1,
    items: [{}],
    mode: 'attachment',
    pages: '1 - 4',
    path: '',
    startLine: 1
  }), { attachmentId: 'attachment-one', pages: '1-4', mode: 'attachment', startLine: 1, endLine: 1 });
  assert.deepEqual(compactReadFileToolArguments({
    attachmentRef: ' F1 ',
    endLine: 1,
    mode: 'attachment',
    startLine: 1
  }), { attachmentRef: 'F1', mode: 'attachment', startLine: 1, endLine: 1 });
});

test('read page ranges reject ambiguous or oversized requests and report actual totals', () => {
  assert.deepEqual(parseReadPageRange(' 2 - 5 '), {
    ok: true,
    range: { start: 2, end: 5, canonical: '2-5' }
  });
  assert.match(parseReadPageRange('0').error, /positive/);
  assert.match(parseReadPageRange('4-2').error, /smaller/);
  assert.match(parseReadPageRange('1-5').error, /at most 4/);
  assert.match(parseReadPageRange('1,3').error, /N-M/);
  assert.deepEqual(resolveReadPageRange('4-7', 5), {
    ok: true,
    range: {
      requestedPages: '4-7',
      returnedPages: '4-5',
      start: 4,
      end: 5,
      totalPages: 5,
      hasMore: false
    }
  });
  assert.match(resolveReadPageRange('6', 5).error, /has 5 page/);
});

test('read copies only the requested real PDF pages and reports the next range', async () => {
  const attachmentId = 'attachment-existing-pdf';
  const sourceBytes = await createPdfBytes(6);
  const requested = [];
  const managed = {
    inlineData: {
      attachmentId,
      name: 'existing.pdf',
      mimeType: 'application/pdf',
      sizeBytes: sourceBytes.byteLength,
      sha256: 'c'.repeat(64),
      storage: 'managed',
      status: 'available'
    }
  };
  const deps = {
    fs: new Proxy({}, { get: () => () => { throw new Error('filesystem must not run'); } }),
    command: {},
    workEnvironment: {},
    skills: {},
    attachments: {
      async reference(requestedId) {
        requested.push(`reference:${requestedId}`);
        return structuredClone(managed);
      },
      async resolve(requestedId) {
        requested.push(`resolve:${requestedId}`);
        return { inlineData: { ...managed.inlineData, data: sourceBytes.toString('base64') } };
      }
    }
  };
  const context = { settingsSnapshot: { enableMultimodalTools: true }, emit() {} };
  const result = await readFileTool.execute(
    { attachmentId, pages: '2 - 5', items: [{}] },
    deps,
    context
  );

  assert.equal(result.ok, true);
  assert.deepEqual(requested, [`reference:${attachmentId}`, `resolve:${attachmentId}`]);
  assert.equal(result.output.attachmentId, attachmentId);
  assert.equal(result.output.name, 'existing.pdf');
  assert.equal(result.output.mimeType, 'application/pdf');
  assert.equal(result.output.sourceSizeBytes, sourceBytes.byteLength);
  assert.equal(result.output.requestedPages, '2-5');
  assert.equal(result.output.returnedPages, '2-5');
  assert.equal(result.output.totalPages, 6);
  assert.equal(result.output.hasMore, true);
  assert.equal(result.output.nextPages, '6');
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].inlineData.attachmentId, undefined);
  assert.equal(result.parts[0].inlineData.mimeType, 'application/pdf');
  assert.equal(result.parts[0].inlineData.storage, 'embedded');
  assert.equal(result.parts[0].inlineData.name, 'existing.pages-2-5.pdf');
  const selectedPdf = await PDFDocument.load(Buffer.from(result.parts[0].inlineData.data, 'base64'));
  assert.equal(selectedPdf.getPageCount(), 4);
  assert.deepEqual(selectedPdf.getPages().map((page) => page.getWidth()), [602, 603, 604, 605]);

  const firstPage = await readFileTool.execute({ attachmentId }, deps, context);
  assert.equal(firstPage.ok, true);
  assert.equal(firstPage.output.returnedPages, '1');
  assert.equal(firstPage.output.nextPages, '2');
  const firstPdf = await PDFDocument.load(Buffer.from(firstPage.parts[0].inlineData.data, 'base64'));
  assert.deepEqual(firstPdf.getPages().map((page) => page.getWidth()), [601]);

  const clamped = await readFileTool.execute({ attachmentId, pages: '5-8' }, deps, context);
  assert.equal(clamped.ok, true);
  assert.equal(clamped.output.requestedPages, '5-8');
  assert.equal(clamped.output.returnedPages, '5-6');
  assert.equal(clamped.output.hasMore, false);
  const clampedPdf = await PDFDocument.load(Buffer.from(clamped.parts[0].inlineData.data, 'base64'));
  assert.deepEqual(clampedPdf.getPages().map((page) => page.getWidth()), [605, 606]);

  const localReads = [];
  const local = await readFileTool.execute(
    { path: 'other.pdf', attachmentId, mode: 'attachment' },
    { ...deps,
      fs: { async readBinaryFile(file, mimeType) {
        localReads.push([file, mimeType]);
        return { path: file, name: 'other.pdf', data: sourceBytes.toString('base64'), sizeBytes: sourceBytes.byteLength };
      } },
      attachments: { reference() { assert.fail('the selected local path must not resolve the managed attachment'); },
        resolve() { assert.fail('the selected local path must not read managed bytes'); } }
    },
    context
  );
  assert.equal(local.ok, true);
  assert.deepEqual(localReads, [['other.pdf', 'application/pdf']]);
  assert.deepEqual(local.output.ignoredFields, ['attachmentRef']);
  assert.equal(local.output.warning, '已选择 path；未使用参数：attachmentRef。');
  assert.equal(local.parts[0].inlineData.sourcePath, 'other.pdf');
});

test('read keeps images whole and rejects pages for image attachments', async () => {
  const attachmentId = 'attachment-image';
  const reference = {
    inlineData: {
      attachmentId,
      name: 'diagram.png',
      mimeType: 'image/png',
      sizeBytes: 123,
      storage: 'managed',
      status: 'available'
    }
  };
  const deps = {
    fs: new Proxy({}, { get: () => () => { throw new Error('filesystem must not run'); } }),
    command: {},
    workEnvironment: {},
    skills: {},
    attachments: { async reference() { return structuredClone(reference); } }
  };
  const context = { settingsSnapshot: { enableMultimodalTools: true }, emit() {} };

  const whole = await readFileTool.execute({ attachmentId }, deps, context);
  assert.equal(whole.ok, true);
  assert.deepEqual(whole.parts, [reference]);

  const paged = await readFileTool.execute({ attachmentId, pages: '1' }, deps, context);
  assert.equal(paged.ok, false);
  assert.match(String(paged.output), /not supported for image/);
});

test('read rejects damaged managed PDFs without pretending pages were returned', async () => {
  const attachmentId = 'attachment-damaged-pdf';
  const reference = {
    inlineData: {
      attachmentId,
      name: 'damaged.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 9,
      storage: 'managed',
      status: 'available'
    }
  };
  const result = await readFileTool.execute({ attachmentId, pages: '1' }, {
    fs: new Proxy({}, { get: () => () => { throw new Error('filesystem must not run'); } }),
    command: {},
    workEnvironment: {},
    skills: {},
    attachments: {
      async reference() { return structuredClone(reference); },
      async resolve() {
        return { inlineData: { ...reference.inlineData, data: Buffer.from('not a pdf').toString('base64') } };
      }
    }
  }, { settingsSnapshot: { enableMultimodalTools: true }, emit() {} });

  assert.equal(result.ok, false);
  assert.match(String(result.output), /could not be paged/);
  assert.equal(result.parts, undefined);
});

test('read decodes a managed TXT as bounded UTF-8 without requiring multimodal support', async () => {
  const attachmentId = 'attachment-notes-txt';
  const content = 'first line\n第二行';
  const bytes = Buffer.from(content, 'utf8');
  const reference = {
    inlineData: {
      attachmentId,
      name: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      storage: 'managed',
      status: 'available'
    }
  };
  const deps = {
    fs: new Proxy({}, { get: () => () => { throw new Error('filesystem must not run'); } }),
    command: {},
    workEnvironment: {},
    skills: {},
    attachments: {
      async reference(requestedId) {
        assert.equal(requestedId, attachmentId);
        return structuredClone(reference);
      },
      async resolve(requestedId) {
        assert.equal(requestedId, attachmentId);
        return { inlineData: { ...reference.inlineData, data: bytes.toString('base64') } };
      }
    }
  };

  const result = await readFileTool.execute({
    attachmentId,
    mode: 'text',
    path: '',
    items: [{}],
    startLine: null,
    endLine: null
  }, deps, {
    settingsSnapshot: { enableMultimodalTools: false },
    emit() {}
  });

  assert.equal(result.ok, true);
  const { ignoredFields, warning, ...textOutput } = result.output;
  assert.deepEqual(ignoredFields, ['mode']);
  assert.equal(warning, '已选择 attachmentRef；未使用参数：mode。');
  assert.deepEqual(textOutput, {
    attachmentId,
    name: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: bytes.length,
    requestedPages: '1',
    returnedPages: '1',
    totalPages: 1,
    hasMore: false,
    content
  });
  assert.equal(result.parts, undefined);
});

test('read can page through a managed TXT and reconstruct every character exactly once', async () => {
  const attachmentId = 'attachment-large-txt';
  const content = [
    ...Array.from({ length: 12 }, (_, index) => `section-${index}\n${String(index % 10).repeat(5_000)}\n`),
    'x'.repeat(10_000),
    '🙂tail'
  ].join('');
  const expectedPages = splitReadTextPages(content);
  assert.ok(expectedPages.length > 4);
  assert.equal(expectedPages.join(''), content);
  const bytes = Buffer.from(content, 'utf8');
  const reference = {
    inlineData: {
      attachmentId,
      name: 'large.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      storage: 'managed',
      status: 'available'
    }
  };
  const deps = {
    fs: new Proxy({}, { get: () => () => { throw new Error('filesystem must not run'); } }),
    command: {},
    workEnvironment: {},
    skills: {},
    attachments: {
      async reference() { return structuredClone(reference); },
      async resolve() {
        return { inlineData: { ...reference.inlineData, data: bytes.toString('base64') } };
      }
    }
  };

  const reconstructed = [];
  for (let page = 1; page <= expectedPages.length; page += 1) {
    const result = await readFileTool.execute({ attachmentId, pages: String(page) }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.output.requestedPages, String(page));
    assert.equal(result.output.returnedPages, String(page));
    assert.equal(result.output.totalPages, expectedPages.length);
    assert.equal(result.output.hasMore, page < expectedPages.length);
    assert.equal(result.output.nextPages, page < expectedPages.length ? String(page + 1) : undefined);
    reconstructed.push(result.output.content);
  }
  assert.equal(reconstructed.join(''), content);

  const range = await readFileTool.execute({ attachmentId, pages: '1 - 4' }, deps);
  assert.equal(range.ok, true);
  assert.equal(range.output.returnedPages, '1-4');
  assert.equal(range.output.content, expectedPages.slice(0, 4).join(''));
  assert.equal(range.output.nextPages, `5-${Math.min(8, expectedPages.length)}`);
});

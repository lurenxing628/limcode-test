import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import path from 'node:path';

async function functions(context) {
  const server = await createServer({ configFile: path.join(process.cwd(), 'vite.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  context.after(() => server.close());
  return server.ssrLoadModule('@webview/components/conversation/scrollAnchor');
}

function viewport() {
  const positions = new Map([['message-1', 200], ['message-2', 600]]);
  const scroller = {
    scrollTop: 240, scrollHeight: 2000, clientHeight: 800,
    getBoundingClientRect: () => ({ top: 30, bottom: 830 }),
    querySelectorAll: () => [...positions].map(([id, top]) => ({
      dataset: { timelineRowKey: id },
      getBoundingClientRect: () => ({ top: 30 + top - scroller.scrollTop, bottom: 430 + top - scroller.scrollTop })
    }))
  };
  return { positions, scroller };
}

test('capture the visible row on the first earlier-history click without a pending request id', async context => {
  const { captureScrollAnchor } = await functions(context);
  const { scroller } = viewport();
  const anchor = captureScrollAnchor({ scroller, visibleRows: [{ id: 'message-1' }, { id: 'message-2' }], pendingAnchorId: null });
  assert.equal(anchor.anchorId, 'message-1');
  assert.equal(anchor.offsetTop, -40);
});

test('restore message offset after prepending history with unequal heights', async context => {
  const { captureScrollAnchor, restoreScrollAfterHistoryLoad } = await functions(context);
  const { scroller, positions } = viewport();
  const anchor = captureScrollAnchor({ scroller, visibleRows: [{ id: 'message-1' }, { id: 'message-2' }] });
  positions.set('message-1', 1375);
  positions.set('message-2', 1775);
  scroller.scrollHeight += 1175;
  restoreScrollAfterHistoryLoad({ scroller, anchor });
  assert.equal(scroller.scrollTop, 1415);
  assert.equal(scroller.querySelectorAll()[0].getBoundingClientRect().top - 30, -40);
  restoreScrollAfterHistoryLoad({ scroller, anchor });
  assert.equal(scroller.scrollTop, 1415, 'do not apply the delta twice after browser anchoring');
});

test('missing message anchor leaves the current viewport untouched', async context => {
  const { captureScrollAnchor, restoreScrollAfterHistoryLoad } = await functions(context);
  const { scroller, positions } = viewport();
  const anchor = captureScrollAnchor({ scroller, visibleRows: [{ id: 'message-1' }] });
  positions.delete('message-1');
  restoreScrollAfterHistoryLoad({ scroller, anchor });
  assert.equal(scroller.scrollTop, 240);
});

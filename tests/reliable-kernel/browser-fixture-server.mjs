import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';

export async function createBrowserFixtureServer({ plugins, dependencies }) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'limcode-browser-vite-'));
  let vite;
  try {
    vite = await createViteServer({
      configFile: path.resolve('vite.config.ts'),
      cacheDir,
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, ws: false },
      optimizeDeps: { noDiscovery: true, include: dependencies, holdUntilCrawlEnd: false },
      plugins
    });
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
  // Vite treats port: 0 as its default port. A native HTTP listener lets the OS
  // allocate the port while each fixture keeps its own dependency optimizer.
  const httpServer = createHttpServer(vite.middlewares);
  return {
    httpServer,
    async listen() {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
    },
    async close() {
      try {
        if (httpServer.listening) await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      } finally {
        try { await vite.close(); }
        finally { await rm(cacheDir, { recursive: true, force: true }); }
      }
    }
  };
}

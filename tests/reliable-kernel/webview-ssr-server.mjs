import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Vite picks the `production` or `development` export of a package from NODE_ENV. A production
// NODE_ENV in the caller's shell would make SSR modules load a second copy of Pinia and Vue beside
// the one the test imports, so the tests pin it.
process.env.NODE_ENV = 'development';

/**
 * A Vite server that loads Webview modules for a test. It opens no HMR websocket, whose fixed port
 * parallel test files would contend for, does not scan browser dependencies (SSR loading never uses
 * them), and keeps its cache in a temporary directory of its own, removed on close, instead of the
 * shared node_modules/.vite.
 */
export async function createWebviewSsrServer() {
  const { createServer } = await import('vite');
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-webview-ssr-'));
  let server;
  try {
    server = await createServer({
      configFile: path.join(process.cwd(), 'vite.config.ts'),
      cacheDir,
      server: { middlewareMode: true, hmr: false, ws: false },
      optimizeDeps: { noDiscovery: true },
      appType: 'custom',
      logLevel: 'error'
    });
  } catch (error) {
    await fs.rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
  const close = server.close.bind(server);
  server.close = async () => {
    try {
      await close();
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  };
  return server;
}

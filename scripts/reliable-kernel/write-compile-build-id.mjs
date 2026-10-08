import { refreshWebviewBuildId, writeCompileBuildId } from './lib/compile-build-id.mjs';

// A loaded extension fixes this identity when it starts, so a later build can request a reload
// without reading or hashing the entire compiled module tree.
if (process.argv.includes('--webview')) refreshWebviewBuildId();
else writeCompileBuildId();

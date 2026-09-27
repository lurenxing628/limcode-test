// Child process of runtime-data-root-relocation-blind.test.mjs. argv: <scope root> <ready file> <finish file>
// Opens the Runtime of the data set at <scope root> (its Host goes online, like a window of another
// installation or an old version), writes <ready file>, and keeps it open until <finish file> appears.
import fs from 'node:fs/promises';
import { kernel, RootAuthority, rootAuthority } from './runtime-data-root-relocation-fixture.mjs';

const [scopeRoot, readyFile, finishFile] = process.argv.slice(2);
const authority = new RootAuthority(() => rootAuthority.resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `old-workspace-window-${process.pid}` });
await fs.writeFile(readyFile, String(process.pid));
for (;;) {
  try { await fs.access(finishFile); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
}
await database.close();

import fs from 'node:fs/promises';
import path from 'node:path';

/** Model a pointer left by an older installation without restoring production switching. */
export async function publishInitialRuntimeSelection(paths, id, selectionRevision = 1) {
  await fs.writeFile(path.join(paths.globalStoragePath, '.limcode-runtime-selection.json'), JSON.stringify({
    kind: 'limcode-runtime-selection', id, initialized: true,
    selectionRevision, selectedAt: new Date().toISOString()
  }));
}

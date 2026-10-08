import * as vscode from 'vscode';
import type { ApplicationFacade } from '../ApplicationFacade';
import type { GlobalSettingsSection } from '../../shared/protocol';
import { INDEX_FILE, RECORDS_DIR, SETTINGS_ROOT_DIR } from '../../backend/capabilities/vscodeStorage/constants';
import { LIMCODE_GLOBAL_STATUS_FILE } from '../../backend/capabilities/vscodeStorage/globalStatus';
import { isPublishedStorageFileUnchanged } from '../../backend/capabilities/vscodeStorage/storageFilePublications';

// Snapshot reads also create lock owner.json files. Watch only durable store files so a
// refresh cannot observe its own read lock and schedule another refresh indefinitely.
const RECORD_STORE_WATCH_PATTERN = `{${INDEX_FILE},${RECORDS_DIR}/*.json}`;

/** 每个监听都从自己的小目录开始，避免扫描整个插件数据目录和锁文件。 */
const GLOBAL_SETTINGS_WATCH_SPECS = [
  { baseSegments: [], pattern: '{llm,llm-compression,appearance,attachments,checkpoint-maintenance,debug-capture}.json' },
  { baseSegments: ['llm-provider-configs'], pattern: RECORD_STORE_WATCH_PATTERN },
  { baseSegments: ['llm-compression-configs'], pattern: RECORD_STORE_WATCH_PATTERN },
  { baseSegments: ['mcp-servers'], pattern: RECORD_STORE_WATCH_PATTERN }
] as const;

const FILE_NAME_SECTIONS: Record<string, GlobalSettingsSection> = {
  'llm.json': 'llm',
  'llm-compression.json': 'llmCompression',
  'appearance.json': 'appearance',
  'attachments.json': 'attachments',
  'checkpoint-maintenance.json': 'checkpointMaintenance',
  'debug-capture.json': 'debugCapture'
};

const DIRECTORY_SECTIONS: Record<string, GlobalSettingsSection> = {
  'llm-provider-configs': 'llmProviderConfigs',
  'llm-compression-configs': 'llmCompressionConfigs',
  'mcp-servers': 'mcpServers'
};

const REFRESH_DEBOUNCE_MS = 180;

export function registerGlobalSettingsWatcher(
  context: vscode.ExtensionContext,
  application: ApplicationFacade
): void {
  const watcher = new GlobalSettingsWatcher(application, context.globalStorageUri);
  context.subscriptions.push(watcher);
  watcher.start();
}

class GlobalSettingsWatcher implements vscode.Disposable {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly dirtySections = new Map<GlobalSettingsSection, Map<string, vscode.Uri>>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  public constructor(
    private readonly application: ApplicationFacade,
    private readonly canonicalStatusRoot: vscode.Uri
  ) {}

  public start(): void {
    const settingsRoot = vscode.Uri.joinPath(this.application.getStorageRootUri(), SETTINGS_ROOT_DIR);
    for (const spec of GLOBAL_SETTINGS_WATCH_SPECS) {
      const base = vscode.Uri.joinPath(settingsRoot, ...spec.baseSegments);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, spec.pattern));
      const schedule = (uri: vscode.Uri) => this.schedule(uri);
      watcher.onDidCreate(schedule);
      watcher.onDidChange(schedule);
      watcher.onDidDelete(schedule);
      this.watchers.push(watcher);
    }
    const statusWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.canonicalStatusRoot, LIMCODE_GLOBAL_STATUS_FILE)
    );
    const scheduleCommon = (uri: vscode.Uri) => this.scheduleSection('common', uri);
    statusWatcher.onDidCreate(scheduleCommon);
    statusWatcher.onDidChange(scheduleCommon);
    statusWatcher.onDidDelete(scheduleCommon);
    this.watchers.push(statusWatcher);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers.length = 0;
  }

  private schedule(uri: vscode.Uri): void {
    const section = sectionFromSettingsUri(uri);
    if (!section) return;
    this.scheduleSection(section, uri);
  }

  private scheduleSection(section: GlobalSettingsSection, uri: vscode.Uri): void {
    const files = this.dirtySections.get(section) ?? new Map<string, vscode.Uri>();
    files.set(uri.toString(), uri);
    this.dirtySections.set(section, files);
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = undefined;
      const sections = [...this.dirtySections];
      this.dirtySections.clear();
      await Promise.all(sections.map(async ([section, changedFiles]) => {
        const known = await Promise.all([...changedFiles.values()].map(isPublishedStorageFileUnchanged));
        if (this.disposed || known.every(Boolean)) return;
        await this.application.refreshGlobalSettings(section).catch((error) => {
          console.warn(`[LimCode] Failed to refresh externally changed settings: ${section}`, error);
        });
      }));
    }, REFRESH_DEBOUNCE_MS);
  }
}

export function sectionFromSettingsUri(uri: vscode.Uri): GlobalSettingsSection | undefined {
  const segments = uri.path.split('/').filter(Boolean);
  const settingsIndex = segments.lastIndexOf('settings');
  if (settingsIndex < 0) return undefined;
  const rest = segments.slice(settingsIndex + 1);
  if (rest.length === 1) return FILE_NAME_SECTIONS[rest[0]];
  const section = DIRECTORY_SECTIONS[rest[0]];
  if (!section) return undefined;
  if (rest.length === 2 && rest[1] === INDEX_FILE) return section;
  // Keep this boundary aligned with recordStore's direct records/<filename>.json layout.
  if (rest.length === 3 && rest[1] === RECORDS_DIR
    && rest[2].toLowerCase().endsWith('.json') && !rest[2].includes('\\')) return section;
  return undefined;
}

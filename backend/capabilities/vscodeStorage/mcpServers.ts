import * as vscode from 'vscode';
import type { McpServerConfigRecord, McpServersSettingsRecord, McpServerTransportRecord } from '../../../shared/protocol';
import { isSettingsRevisionConflictError } from '../settingsRevisionConflict';
import {
  commitRecordStoreSnapshot,
  loadRecordStoreSnapshot,
  missingRecordStoreRevision,
  type RecordStoreSnapshot
} from './recordStore';
import { storageDirectoryExists } from './localStorageUri';
import type { createVscodeStoragePaths } from './paths';

type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

const MCP_SERVERS_DIR = 'mcp-servers';
const REVISION_SECTION = 'mcpServers';

export interface McpServersSettingsResult {
  section: 'mcpServers';
  settings: McpServersSettingsRecord;
  filePath: string;
  revision: string;
  previousSettings?: McpServersSettingsRecord;
}

export async function loadMcpServersSettings(paths: StoragePaths): Promise<McpServersSettingsResult> {
  const root = mcpServersRootUri(paths);
  const indexUri = mcpServersIndexUri(paths);
  // No settings directory yet (a new data directory, or the mount point of an unmounted drive): no
  // servers, as a missing store; the first save writes it.
  if (!await storageDirectoryExists(paths.settingsRootUri)) return mcpSettingsFromSnapshot(indexUri, { records: [], revision: missingRecordStoreRevision(indexUri) });
  const snapshot = await loadRecordStoreSnapshot<McpServerConfigRecord, 'server'>(root, indexUri, 'server');
  if (snapshot) return mcpSettingsFromSnapshot(indexUri, snapshot);

  try {
    const initialized = await commitRecordStoreSnapshot<McpServerConfigRecord, 'server'>(
      root,
      indexUri,
      [],
      'server',
      (server) => server.name,
      { expectedRevision: missingRecordStoreRevision(indexUri), section: REVISION_SECTION, pruneMissing: true }
    );
    return mcpSettingsFromSnapshot(indexUri, initialized);
  } catch (error) {
    if (!isSettingsRevisionConflictError(error)) throw error;
    const current = await loadRecordStoreSnapshot<McpServerConfigRecord, 'server'>(root, indexUri, 'server');
    if (!current) throw error;
    return mcpSettingsFromSnapshot(indexUri, current);
  }
}

export async function saveMcpServersSettings(
  paths: StoragePaths,
  input: Partial<McpServersSettingsRecord> | undefined,
  expectedRevision: string
): Promise<McpServersSettingsResult> {
  const root = mcpServersRootUri(paths);
  const indexUri = mcpServersIndexUri(paths);
  const settings = normalizeMcpServersSettings(input);
  const committed = await commitRecordStoreSnapshot(
    root,
    indexUri,
    settings.servers,
    'server',
    (server) => server.name,
    { expectedRevision, section: REVISION_SECTION, pruneMissing: true, isDefaultRecords: (records) => records.length === 0 }
  );
  return {
    ...mcpSettingsFromSnapshot(indexUri, committed),
    previousSettings: normalizeMcpServersSettings({ servers: committed.previousRecords })
  };
}

function mcpSettingsFromSnapshot(
  indexUri: vscode.Uri,
  snapshot: RecordStoreSnapshot<McpServerConfigRecord>
): McpServersSettingsResult {
  return {
    section: 'mcpServers',
    settings: normalizeMcpServersSettings({ servers: snapshot.records }),
    filePath: indexUri.fsPath,
    revision: snapshot.revision
  };
}

export function normalizeMcpServersSettings(input: Partial<McpServersSettingsRecord> | undefined): McpServersSettingsRecord {
  const byId = new Map<string, McpServerConfigRecord>();
  for (const raw of input?.servers ?? []) {
    const server = normalizeMcpServerConfig(raw);
    if (server) byId.set(server.id, server);
  }
  return { servers: [...byId.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)) };
}

function normalizeMcpServerConfig(input: Partial<McpServerConfigRecord> | undefined): McpServerConfigRecord | undefined {
  const id = sanitizeId(input?.id);
  const transport = normalizeTransport(input?.transport);
  if (!id || !transport) return undefined;
  const now = Date.now();
  const createdAt = finiteNonNegativeInteger(input?.createdAt, now);
  return {
    id,
    name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : id,
    enabled: input?.enabled !== false,
    transport,
    createdAt,
    updatedAt: Math.max(createdAt, finiteNonNegativeInteger(input?.updatedAt, createdAt))
  };
}

function normalizeTransport(input: Partial<McpServerTransportRecord> | undefined): McpServerTransportRecord | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (input.kind === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    const args = Array.isArray(input.args) ? input.args.map((item) => String(item).trim()).filter(Boolean) : [];
    const env = normalizeStringRecord(input.env);
    const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined;
    return { kind: 'stdio', command, ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) };
  }
  if (input.kind === 'http') {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    const headers = normalizeStringRecord(input.headers);
    return { kind: 'http', url, ...(headers ? { headers } : {}) };
  }
  return undefined;
}

function normalizeStringRecord(input: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    record[key] = String(rawValue);
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function sanitizeId(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    : '';
}

function finiteNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function mcpServersRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.settingsRootUri, MCP_SERVERS_DIR);
}

function mcpServersIndexUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(mcpServersRootUri(paths), 'index.json');
}

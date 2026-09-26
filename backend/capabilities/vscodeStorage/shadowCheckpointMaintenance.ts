import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import type { ShadowRepositoryDiskStatRecord } from '../../../shared/protocol';
import type { StoragePaths } from './paths';
import { isPathBelow } from '../filesystem/pathContainment';

const SCAN_TEMP_PREFIX = '.checkpoint-scan-';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface WorktreeAggregate {
  sizeBytes: number;
  fileCount: number;
  lastActiveAt: number;
}

/** 扫描 shadow worktrees 根目录，统计每个 worktree 的磁盘占用、项目文件数与最近活跃时间。 */
export async function collectShadowWorktreeStats(paths: StoragePaths): Promise<ShadowRepositoryDiskStatRecord[]> {
  const root = paths.checkpointShadowWorktreesRootPath;
  const entries = await readDirSafe(root);
  const stats: ShadowRepositoryDiskStatRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(SCAN_TEMP_PREFIX)) continue;
    const aggregate = await aggregateWorktree(path.join(root, entry.name));
    stats.push({
      storageKey: entry.name,
      exists: true,
      sizeBytes: aggregate.sizeBytes,
      fileCount: aggregate.fileCount,
      ...(aggregate.lastActiveAt > 0 ? { lastActiveAt: aggregate.lastActiveAt } : {})
    });
  }
  return stats.sort((left, right) => right.sizeBytes - left.sizeBytes || left.storageKey.localeCompare(right.storageKey));
}

/** 删除指定 storageKey 对应的物理 shadow worktree（不触碰 ECS / skeleton 记录）。 */
export async function deleteShadowWorktrees(paths: StoragePaths, storageKeys: readonly string[]): Promise<{ deletedStorageKeys: string[] }> {
  const root = paths.checkpointShadowWorktreesRootPath;
  const deletedStorageKeys: string[] = [];
  for (const rawKey of storageKeys) {
    const storageKey = sanitizeStorageKey(rawKey);
    if (!storageKey) continue;
    const target = path.join(root, storageKey);
    if (!isInsideRoot(root, target)) continue;
    try {
      await fs.rm(target, { recursive: true, force: true });
      deletedStorageKeys.push(storageKey);
    } catch (error) {
      console.warn(`[LimCode] Failed to delete shadow worktree: ${storageKey}`, error);
    }
  }
  return { deletedStorageKeys };
}

/** 删除最近 maxAgeDays 天内未活跃的 shadow worktree。 */
export async function cleanupUnusedShadowWorktrees(paths: StoragePaths, maxAgeDays: number): Promise<{ deletedStorageKeys: string[] }> {
  const days = Math.max(1, Math.floor(maxAgeDays));
  const threshold = Date.now() - days * MS_PER_DAY;
  const stats = await collectShadowWorktreeStats(paths);
  const stale = stats.filter((stat) => (stat.lastActiveAt ?? 0) < threshold).map((stat) => stat.storageKey);
  if (stale.length === 0) return { deletedStorageKeys: [] };
  return deleteShadowWorktrees(paths, stale);
}

async function aggregateWorktree(dir: string): Promise<WorktreeAggregate> {
  const aggregate: WorktreeAggregate = { sizeBytes: 0, fileCount: 0, lastActiveAt: 0 };
  await walk(dir, aggregate, false);
  return aggregate;
}

async function walk(dir: string, aggregate: WorktreeAggregate, insideGit: boolean): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, aggregate, insideGit || entry.name === '.git');
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(full).catch(() => undefined);
    if (!stat) continue;
    aggregate.sizeBytes += stat.size;
    if (!insideGit) aggregate.fileCount += 1;
    if (stat.mtimeMs > aggregate.lastActiveAt) aggregate.lastActiveAt = stat.mtimeMs;
  }
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sanitizeStorageKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return undefined;
  return trimmed;
}

function isInsideRoot(root: string, target: string): boolean {
  return isPathBelow(root, target);
}

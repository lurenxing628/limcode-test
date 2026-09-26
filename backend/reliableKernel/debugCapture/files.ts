import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Dir } from 'node:fs';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../../capabilities/filesystem/durableDirectorySync';
import { isPathInside } from '../../capabilities/filesystem/pathContainment';
import type { RootBinding } from '../contracts';
import type { RootAuthority } from '../rootAuthority';
import { DEBUG_CAPTURE_LIMITS, type DebugCaptureEvent, type DebugCaptureManifest, type DebugCaptureSourceRef, type DebugCaptureStopReason } from '../../../shared/debugCapture';
import type { DebugCaptureInput } from './observer';
import { boundedJsonBytes } from '../../../shared/debugCaptureEncoding';

const MANIFEST_LIMIT = DEBUG_CAPTURE_LIMITS.reserveBytes / 4;
const RUN_NAME = /^\d{8}-\d{6}-\d{3}-model-stream-[a-f0-9]{8}$/;
const FILES = new Set(['manifest.json', 'manifest.json.tmp', 'events.jsonl', 'payloads.bin']);
type Pending = { payload?: Buffer; line: Buffer; seq: number };

export class DebugCaptureFiles {
  public readonly directory: string;
  private manifest?: DebugCaptureManifest;
  private pending: Pending[] = [];
  private memoryBytes = 0;
  private acceptedPayloadBytes = 0;
  private acceptedIndexBytes = 0;
  private payloadFile?: fs.FileHandle;
  private indexFile?: fs.FileHandle;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private operations: Promise<unknown> = Promise.resolve();
  private recording = false;
  private failed = false;
  private startedMark = 0;
  private readonly readers = new Set<string>();

  public constructor(
    private readonly authority: Pick<RootAuthority, 'validate'>,
    private readonly binding: RootBinding,
    private readonly onStop: (reason: DebugCaptureStopReason, detail?: string) => void
  ) { this.directory = path.join(binding.paths.dataRootPath, 'diagnostics', 'debug-captures'); }

  public validate(): Promise<unknown> { return this.authority.validate(this.binding); }
  public progress(runId: string): DebugCaptureManifest | undefined {
    return this.manifest?.runId === runId ? structuredClone(this.manifest) : undefined;
  }

  public async inventory(): Promise<{ runs: DebugCaptureManifest[]; totalBytes: number }> {
    await this.validate();
    const runs: DebugCaptureManifest[] = [];
    let totalBytes = 0;
    let directory: Dir;
    try { directory = await fs.opendir(this.directory); }
    catch (error) { if (missing(error)) return { runs, totalBytes }; throw error; }
    for await (const entry of directory) {
      if (!entry.isDirectory() || !RUN_NAME.test(entry.name)) throw new Error('取证目录存在未知项目，请先人工检查。');
      if (runs.length >= DEBUG_CAPTURE_LIMITS.maxRuns) throw new Error('取证目录超过允许的记录份数。');
      totalBytes += await this.size(entry.name);
      const stored = await this.readManifest(entry.name);
      if (stored.status !== 'sealed' && this.manifest?.runId !== stored.runId) {
        stored.status = 'sealed'; stored.stopReason = 'interrupted'; stored.hasGaps = true;
        stored.gapReason = '扩展异常中断，文件没有正常封存。';
      }
      runs.push(stored);
    }
    return { runs: runs.sort((a, b) => b.runId.localeCompare(a.runId)), totalBytes };
  }

  public async begin(manifest: DebugCaptureManifest): Promise<void> {
    await this.validate();
    if (this.recording || this.writing) throw new Error('旧取证尚未停止。');
    const root = this.runPath(manifest.runId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(path.dirname(this.directory))).isDirectory()
      || !(await fs.lstat(this.directory)).isDirectory()) throw new Error('取证目录不能是链接。');
    await this.validate();
    await fs.mkdir(root, { mode: 0o700 });
    this.manifest = structuredClone(manifest);
    this.failed = false;
    this.startedMark = performance.now();
    this.acceptedPayloadBytes = this.acceptedIndexBytes = this.memoryBytes = 0;
    this.pending = [];
    try {
      await this.validate();
      this.payloadFile = await fs.open(path.join(root, 'payloads.bin'), 'wx', 0o600);
      await this.validate();
      this.indexFile = await fs.open(path.join(root, 'events.jsonl'), 'wx', 0o600);
      await this.publish();
      this.recording = true;
      await syncDirectoryDurably(this.directory);
    } catch (error) {
      await this.closeHandles();
      this.recording = false;
      this.manifest = undefined;
      // 尚未接收任何事件，只清理由本次失败开启创建的空记录。
      await this.validate().then(() => fs.rm(root, { recursive: true })).catch(() => undefined);
      throw error;
    }
  }

  public async rememberCommand(runId: string, commandId: string): Promise<void> {
    if (!this.manifest || this.manifest.runId !== runId || !this.recording) throw new Error('取证已结束。');
    await this.flush();
    await this.serialize(async () => {
      if (!this.recording || this.failed) throw new Error('取证已结束。');
      const old = this.manifest!.commandAliases;
      this.manifest!.commandAliases = [...old, commandId];
      try { await this.publish(); }
      catch (error) { this.manifest!.commandAliases = old; throw error; }
    });
  }

  public record(input: DebugCaptureInput): DebugCaptureSourceRef | undefined {
    const run = this.manifest;
    if (!run || !this.recording || this.failed) return undefined;
    let attemptedBytes = 0;
    let sizeKnown = false;
    try {
      const remaining = Math.min(run.maxBytes - run.acceptedBytes, (DEBUG_CAPTURE_LIMITS.memoryBytes - DEBUG_CAPTURE_LIMITS.reserveBytes - this.memoryBytes) / 4);
      let parts: readonly Uint8Array[] = [];
      if (input.bytes !== undefined) {
        parts = input.bytes instanceof ArrayBuffer ? [new Uint8Array(input.bytes)]
          : Array.isArray(input.bytes) ? input.bytes : [input.bytes as Uint8Array];
        attemptedBytes = parts.reduce((sum, bytes) => sum + bytes.byteLength, 0);
        sizeKnown = true;
        if (attemptedBytes > remaining) throw new RangeError('原始消息超过剩余预算。');
      } else if (input.payload !== undefined) { attemptedBytes = boundedJsonBytes(input.payload, remaining); sizeKnown = true; }
      const event: DebugCaptureEvent = {
        runId: run.runId, captureSeq: run.lastAcceptedSeq + 1, observedAt: new Date().toISOString(),
        elapsedMs: Math.max(0, performance.now() - this.startedMark), stage: input.stage,
        ...(input.context ? { context: input.context } : {}), sources: [...(input.sources ?? [])], metadata: input.metadata ?? {},
        ...(input.bytes !== undefined || input.payload !== undefined ? { payload: {
          offset: this.acceptedPayloadBytes, length: attemptedBytes, sha256: '0'.repeat(64), encoding: input.bytes !== undefined ? 'bytes' as const : 'json' as const
        } } : {})
      };
      const indexBytes = boundedJsonBytes(event, remaining - attemptedBytes) + 1;
      const required = indexBytes + attemptedBytes;
      if (run.acceptedBytes + required > run.maxBytes) throw new RangeError('取证达到单次容量上限。');
      if (this.memoryBytes + required * 4 > DEBUG_CAPTURE_LIMITS.memoryBytes) throw new RangeError('取证队列达到内存上限。');
      const payload = event.payload ? input.bytes !== undefined
        ? Buffer.concat(parts.map(part => Buffer.from(part.buffer, part.byteOffset, part.byteLength)), attemptedBytes)
        : Buffer.from(JSON.stringify(input.payload), 'utf8') : undefined;
      if (event.payload && payload) event.payload.sha256 = sha256(payload);
      const line = Buffer.from(JSON.stringify(event) + '\n');
      if (line.length !== indexBytes || (payload?.length ?? 0) !== attemptedBytes) throw new Error('取证编码长度不一致。');
      run.peakMemoryBytes = Math.max(run.peakMemoryBytes, this.memoryBytes + required * 4);
      this.memoryBytes += required;
      run.acceptedBytes += required;
      run.lastAcceptedSeq = event.captureSeq;
      this.acceptedPayloadBytes += attemptedBytes;
      this.acceptedIndexBytes += indexBytes;
      this.pending.push({ payload, line, seq: event.captureSeq });
      this.schedule();
      return { runId: run.runId, captureSeq: event.captureSeq };
    } catch (error) {
      const memory = DEBUG_CAPTURE_LIMITS.memoryBytes - DEBUG_CAPTURE_LIMITS.reserveBytes - this.memoryBytes;
      const reason: DebugCaptureStopReason = error instanceof RangeError
        ? (run.maxBytes - run.acceptedBytes <= memory / 4 ? 'size_limit' : 'memory_limit') : 'write_failed';
      this.recording = false;
      run.hasGaps = true;
      run.gapReason = `${error instanceof Error ? error.message : String(error)} 未保存事件：${input.stage}，${sizeKnown ? `原文字节数：${attemptedBytes}` : '原文总字节数未计算'}。`;
      this.notifyStop(reason, run.gapReason);
      return undefined;
    }
  }

  public async flush(): Promise<void> {
    if (this.writing) return this.writing;
    this.clearTimer();
    if (!this.pending.length || this.failed) return;
    const batch = this.pending.splice(0);
    const bytes = batch.reduce((sum, entry) => sum + entry.line.length + (entry.payload?.length ?? 0), 0);
    this.writing = this.serialize(async () => {
      const run = this.manifest!;
      try {
        for (const entry of batch) {
          if (entry.payload) { await this.validate(); await this.payloadFile!.writeFile(entry.payload); }
        }
        await this.validate(); await this.payloadFile!.sync();
        for (const entry of batch) { await this.validate(); await this.indexFile!.writeFile(entry.line); }
        await this.validate(); await this.indexFile!.sync();
        await this.publish(false, {
          payloadBytes: run.payloadBytes + batch.reduce((sum, entry) => sum + (entry.payload?.length ?? 0), 0),
          indexBytes: run.indexBytes + batch.reduce((sum, entry) => sum + entry.line.length, 0),
          durableSeq: batch[batch.length - 1].seq, batches: run.batches + 1
        });
      } catch (error) {
        this.failed = true;
        this.recording = false;
        run.hasGaps = true;
        run.gapReason = error instanceof Error ? error.message : String(error);
        this.pending = [];
        this.memoryBytes = bytes;
        this.notifyStop('write_failed', run.gapReason);
      } finally { this.memoryBytes = Math.max(0, this.memoryBytes - bytes); }
    }).finally(() => {
      this.writing = undefined;
      if (this.recording && this.pending.length) this.schedule();
    });
    return this.writing;
  }

  public async seal(control: DebugCaptureManifest): Promise<void> {
    this.recording = false;
    this.clearTimer();
    while (this.writing || (this.pending.length && !this.failed)) await this.flush();
    const run = this.manifest;
    if (!run || run.runId !== control.runId) throw new Error('取证编号不匹配。');
    run.status = 'sealed'; run.stoppedAt = control.stoppedAt; run.stopReason = control.stopReason;
    run.elapsedMs = control.elapsedMs;
    if (control.hasGaps) { run.hasGaps = true; run.gapReason = control.gapReason; }
    try {
      if (this.failed) throw new Error(run.gapReason ?? '取证写入失败，文件未正常封存。');
      await this.serialize(() => this.publish(true));
    } finally { await this.closeHandles(); this.memoryBytes = 0; this.pending = []; }
  }

  public async abandon(): Promise<void> {
    this.recording = false; this.clearTimer();
    await this.writing;
    this.pending = []; this.memoryBytes = 0;
    await this.closeHandles();
    if (this.manifest && this.manifest.status !== 'sealed') { this.manifest.status = 'sealed'; this.manifest.hasGaps = true; }
  }

  public async readManifest(runId: string): Promise<DebugCaptureManifest> {
    await this.validate();
    await this.size(runId);
    const file = path.join(this.runPath(runId), 'manifest.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MANIFEST_LIMIT) throw new Error('取证清单损坏或超限。');
    const run = JSON.parse(await fs.readFile(file, 'utf8')) as DebugCaptureManifest;
    if (run.runId !== runId || !Array.isArray(run.commandAliases) || !run.target
      || !['recording', 'stopping', 'sealed'].includes(run.status)
      || !['conversation', 'workspace'].includes(run.target.scope)
      || (run.target.scope === 'conversation' && typeof run.target.conversationId !== 'string')
      || typeof run.commandId !== 'string' || run.commandAliases.some(value => typeof value !== 'string')
      || typeof run.source?.extensionVersion !== 'string' || typeof run.source?.sourceCommit !== 'string'
      || typeof run.source?.hostBootId !== 'string' || !run.source?.moduleHashes
      || Object.values(run.source.moduleHashes).some(value => typeof value !== 'string')
      || ![8, 16, 32].includes(run.maxBytes / 1_048_576)
      || !Number.isSafeInteger(run.lastAcceptedSeq) || run.lastAcceptedSeq < run.durableSeq
      || !Number.isSafeInteger(run.durableSeq) || run.durableSeq < 0
      || !Number.isSafeInteger(run.payloadBytes) || run.payloadBytes < 0
      || !Number.isSafeInteger(run.indexBytes) || run.indexBytes < 0
      || run.payloadBytes + run.indexBytes > 32 * 1_048_576) throw new Error('取证清单内容无效。');
    return run;
  }

  public async withRead<T>(runId: string, read: (root: string, manifest: DebugCaptureManifest) => Promise<T>): Promise<T> {
    if (this.manifest?.runId === runId && (this.recording || this.writing || this.manifest.status !== 'sealed')) throw new Error('请先停止当前取证。');
    if (this.readers.has(runId)) throw new Error('记录使用中，请稍后重试。');
    this.readers.add(runId);
    try { return await read(this.runPath(runId), await this.readManifest(runId)); }
    finally { this.readers.delete(runId); }
  }

  public async remove(runId: string): Promise<void> {
    await this.withRead(runId, async root => { await this.validate(); await fs.rm(root, { recursive: true }); });
  }

  public async export(runId: string, target: string): Promise<void> {
    await this.withRead(runId, async root => {
      if (isPathInside(this.directory, target)) throw new Error('导出位置不能位于取证目录内。');
      await this.validate();
      await fs.mkdir(target, { recursive: false });
      for (const entry of await fs.readdir(root)) {
        await this.validate();
        await fs.copyFile(path.join(root, entry), path.join(target, entry), fs.constants.COPYFILE_EXCL);
      }
    });
  }

  public runPath(runId: string): string {
    if (!RUN_NAME.test(runId)) throw new Error('取证编号无效。');
    return path.join(this.directory, runId);
  }

  private async size(runId: string): Promise<number> {
    const root = this.runPath(runId);
    if (!(await fs.lstat(root)).isDirectory()) throw new Error('取证路径不是普通目录。');
    let bytes = 0;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !FILES.has(entry.name)) throw new Error('取证记录包含未知文件或链接。');
      bytes += (await fs.lstat(path.join(root, entry.name))).size;
    }
    return bytes;
  }

  private async publish(final = false, progress: Partial<Pick<DebugCaptureManifest, 'payloadBytes' | 'indexBytes' | 'durableSeq' | 'batches'>> = {}): Promise<void> {
    const run = this.manifest!;
    const charge = boundedJsonBytes({ ...run, ...progress }, MANIFEST_LIMIT - 32) + 32;
    if (!final && run.acceptedBytes + charge > run.maxBytes) {
      this.recording = false;
      // 此次截止点及最终封存使用开启时预留的收尾空间，不丢弃已同步的前缀。
      this.notifyStop('size_limit', '可靠截止点写入达到本次容量上限。');
    } else if (!final) {
      run.acceptedBytes += charge;
    }
    const text = JSON.stringify({ ...run, ...progress });
    const root = this.runPath(run.runId);
    const temporary = path.join(root, 'manifest.json.tmp');
    await this.validate();
    const handle = await fs.open(temporary, 'w', 0o600);
    try { await handle.writeFile(text); await this.validate(); await handle.sync(); }
    finally { await handle.close(); }
    await this.validate();
    await fs.rename(temporary, path.join(root, 'manifest.json'));
    await syncDirectoryDurably(root);
    Object.assign(run, progress);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation);
    this.operations = task.catch(() => undefined);
    return task;
  }
  private notifyStop(reason: DebugCaptureStopReason, detail?: string): void {
    try { this.onStop(reason, detail); } catch { /* 观察失败不能影响模型处理。 */ }
  }

  private schedule(): void {
    if (this.timer || this.writing || !this.recording) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, DEBUG_CAPTURE_LIMITS.flushMs);
    this.timer.unref();
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async closeHandles(): Promise<void> {
    await this.payloadFile?.close().catch(() => undefined);
    await this.indexFile?.close().catch(() => undefined);
    this.payloadFile = this.indexFile = undefined;
  }
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

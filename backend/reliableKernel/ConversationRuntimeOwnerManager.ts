import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootBinding, RuntimeRootPaths } from './contracts';
import { ExecutionHandoffError } from './executionLeaseFence';
import { parseRootBinding } from './rootAuthority';
import {
  classifyRecordedProcess,
  isolateDeadClaimRecord,
  ownProcessStartIdentity,
  readClaimRecord,
  releaseClaimRecord,
  requireNonEmptyText,
  tryPublishClaimRecord
} from './runtimeClaimPrimitives';

export const CONVERSATION_RUNTIME_OWNERS_DIRECTORY = 'conversation-owners';
export const CONVERSATION_RUNTIME_OWNER_RECORD_FILE = 'owner.json';

/**
 * Durable per-conversation Runtime owner record. The identity tuple (dataSetId, rootInstanceId,
 * rootGeneration) binds the claim to one exact Runtime root generation; processId and
 * processStartIdentity are the only evidence peers may use to prove the owner dead or reused.
 */
export interface ConversationRuntimeOwnerMetadata {
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  conversationId: string;
  hostBootId: string;
  ownerToken: string;
  processId: number;
  processStartIdentity: string;
  startedAt: string;
}

export class ConversationRuntimeOwnerBusyError extends Error {
  public readonly code = 'conversation-runtime-owner-busy';

  public constructor(
    public readonly conversationId: string,
    public readonly owner: ConversationRuntimeOwnerMetadata
  ) {
    super(
      `另一个窗口正在主持会话 ${conversationId}（进程 ${owner.processId}）；` +
      '只有这个会话被占用，本窗口的其他会话和功能不受影响。'
    );
    this.name = 'ConversationRuntimeOwnerBusyError';
  }
}

export class ConversationRuntimeOwnerClaimError extends Error {
  public constructor(
    public readonly code: 'conversation-runtime-owner-invalid'
      | 'conversation-runtime-owner-mismatch'
      | 'conversation-runtime-owner-unavailable'
      | 'conversation-runtime-owner-closed',
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = 'ConversationRuntimeOwnerClaimError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * Thrown for ExecutionLease-fenced writes after this Host released the local conversation owner.
 * It extends ExecutionHandoffError so existing drive loops stand down exactly like a lease loss.
 */
export class ConversationRuntimeOwnerReleasedError extends ExecutionHandoffError {
  public readonly reason = 'conversation-runtime-owner-released';

  public constructor(
    public readonly conversationId: string,
    public readonly turnId: string
  ) {
    super(
      `Conversation ${conversationId} owner was released locally; ` +
      `fenced execution writes for Turn ${turnId} are rejected.`
    );
    this.name = 'ConversationRuntimeOwnerReleasedError';
  }
}

export function isConversationRuntimeOwnerBusyError(error: unknown): error is ConversationRuntimeOwnerBusyError {
  return error instanceof ConversationRuntimeOwnerBusyError
    || (error instanceof Error && (error as Error & { code?: unknown }).code === 'conversation-runtime-owner-busy');
}

export function isConversationRuntimeOwnerClaimError(error: unknown): error is ConversationRuntimeOwnerClaimError {
  return error instanceof ConversationRuntimeOwnerClaimError;
}

export function isConversationRuntimeOwnerReleasedError(error: unknown): error is ConversationRuntimeOwnerReleasedError {
  return error instanceof ConversationRuntimeOwnerReleasedError;
}

/** Conversation owner claims live in the Runtime control root next to the RootBinding pointer. */
export function conversationRuntimeOwnersRoot(paths: RuntimeRootPaths): string {
  return path.join(
    path.dirname(requireNonEmptyText(paths.rootPointerPath, 'RuntimeRootPaths.rootPointerPath')),
    CONVERSATION_RUNTIME_OWNERS_DIRECTORY
  );
}

export function conversationRuntimeOwnerClaimPath(paths: RuntimeRootPaths, conversationId: string): string {
  const digest = createHash('sha256')
    .update('limcode-conversation-runtime-owner\0')
    .update(requireNonEmptyText(conversationId, 'conversationId'))
    .digest('hex');
  return path.join(conversationRuntimeOwnersRoot(paths), digest);
}

export type ConversationRuntimePendingWorkProbe = (conversationId: string) => Promise<boolean>;

interface OwnedConversation {
  readonly conversationId: string;
  readonly claimPath: string;
  readonly ownerToken: string;
  pins: number;
}

/**
 * Durable single-owner registry for Conversations on one shared Runtime root. Distinct from
 * ExecutionLease: ownership identifies the one Runtime Host allowed to drive/mutate a
 * conversation and is only ever taken over from a definitely dead or reused process identity —
 * never because of elapsed time. Activity pins (commands, drives) delay idle release; a
 * conservative pending-work probe guards the durable gaps. Passive views do not own a writer.
 */
export class ConversationRuntimeOwnerManager {
  private readonly paths: RuntimeRootPaths;
  private readonly dataSetId: string;
  private readonly rootInstanceId: string;
  private readonly rootGeneration: number;
  private readonly processId = process.pid;
  private readonly processStartIdentity = ownProcessStartIdentity();
  private readonly owned = new Map<string, OwnedConversation>();
  private readonly chains = new Map<string, Promise<void>>();
  private pendingWorkProbe: ConversationRuntimePendingWorkProbe = () => Promise.resolve(true);
  private closed = false;

  public constructor(
    binding: RootBinding,
    public readonly hostBootId: string
  ) {
    requireNonEmptyText(hostBootId, 'hostBootId');
    this.paths = binding.paths;
    this.dataSetId = requireNonEmptyText(binding.dataSetId, 'RootBinding.dataSetId');
    this.rootInstanceId = requireNonEmptyText(binding.rootInstanceId, 'RootBinding.rootInstanceId');
    this.rootGeneration = binding.rootGeneration;
    if (!Number.isSafeInteger(this.rootGeneration) || this.rootGeneration <= 0) {
      throw new TypeError('RootBinding.rootGeneration must be a positive integer.');
    }
  }

  /** Local owned-set membership, stable while an activity pin or durable work is present. */
  public owns(conversationId: string): boolean {
    return this.owned.has(conversationId);
  }

  public async claim(conversationId: string): Promise<void> {
    const id = requireNonEmptyText(conversationId, 'conversationId');
    await this.enqueue(id, async () => {
      await this.claimLocked(id, 'throw');
    });
  }

  /** Returns false only when another live or unknown Runtime Host owns the conversation. */
  public async tryClaim(conversationId: string): Promise<boolean> {
    const id = requireNonEmptyText(conversationId, 'conversationId');
    return this.enqueue(id, async () => (await this.claimLocked(id, 'return')) !== undefined);
  }

  /** Verifies local ownership; never acquires implicitly. */
  public async assertOwned(conversationId: string): Promise<void> {
    const id = requireNonEmptyText(conversationId, 'conversationId');
    await this.enqueue(id, async () => {
      if (!this.owned.has(id)) {
        throw new ConversationRuntimeOwnerClaimError(
          'conversation-runtime-owner-mismatch',
          `Conversation ${id} is not owned by this Runtime Host.`
        );
      }
    });
  }

  /**
   * Claims the conversation and holds an activity pin for the whole callback, then releases the
   * owner if it became idle. Nested or overlapping runs cannot drop ownership midway.
   */
  public async run<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const id = requireNonEmptyText(conversationId, 'conversationId');
    await this.enqueue(id, async () => {
      const state = await this.claimLocked(id, 'throw');
      state.pins += 1;
    });
    try {
      return await operation();
    } finally {
      await this.enqueue(id, async () => {
        const state = this.owned.get(id);
        if (state && state.pins > 0) state.pins -= 1;
        await this.releaseIfIdleLocked(id);
      }).catch((error: unknown) => {
        if (!this.closed) throw error;
      });
    }
  }

  public async releaseIfIdle(conversationId: string): Promise<boolean> {
    const id = requireNonEmptyText(conversationId, 'conversationId');
    return this.enqueue(id, () => this.releaseIfIdleLocked(id));
  }

  /** Best-effort idle pass over locally owned conversations without activity pins. */
  public async sweepIdle(): Promise<void> {
    const candidates = [...this.owned.values()]
      .filter((state) => state.pins === 0)
      .map((state) => state.conversationId);
    for (const id of candidates) {
      if (this.closed) return;
      await this.enqueue(id, () => this.releaseIfIdleLocked(id)).catch(() => undefined);
    }
  }

  /** Installs the durable pending-work predicate; the default is conservative (always retains). */
  public setPendingWorkProbe(probe: ConversationRuntimePendingWorkProbe): void {
    if (typeof probe !== 'function') throw new TypeError('Pending work probe must be a function.');
    this.pendingWorkProbe = probe;
  }

  /**
   * Releases every locally owned durable record. Runs only after the database writer is fenced:
   * in-flight pins belong to operations whose writes can no longer commit, and leaving a
   * live-process token behind would block the conversation for every other Host indefinitely.
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.chains.values()]);
    const states = [...this.owned.values()];
    this.owned.clear();
    await Promise.allSettled(states.map((state) => this.releaseRecord(state)));
  }

  private enqueue<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(conversationId) ?? Promise.resolve();
    const run = previous.then(() => {
      if (this.closed) throw closedManagerError();
      return operation();
    });
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(conversationId, tail);
    void tail.then(() => {
      if (this.chains.get(conversationId) === tail) this.chains.delete(conversationId);
    });
    return run;
  }

  private async claimLocked(conversationId: string, busy: 'throw'): Promise<OwnedConversation>;
  private async claimLocked(conversationId: string, busy: 'return'): Promise<OwnedConversation | undefined>;
  private async claimLocked(
    conversationId: string,
    busy: 'throw' | 'return'
  ): Promise<OwnedConversation | undefined> {
    const existing = this.owned.get(conversationId);
    if (existing) return existing;
    const state = await this.acquireRecord(conversationId, busy);
    if (!state) return undefined;
    if (this.closed) {
      await this.releaseRecord(state).catch(() => undefined);
      throw closedManagerError();
    }
    this.owned.set(conversationId, state);
    return state;
  }

  private async releaseIfIdleLocked(conversationId: string): Promise<boolean> {
    const state = this.owned.get(conversationId);
    if (!state || state.pins > 0) return false;
    let pending = true;
    try {
      pending = await this.pendingWorkProbe(conversationId);
    } catch {
      // A probe failure can never be interpreted as proof that no work is pending.
      pending = true;
    }
    if (pending) return false;
    // Local ownership drops before the durable record so stale fenced writes fail immediately;
    // the durable release below is exact-token and never touches another owner's record.
    this.owned.delete(conversationId);
    await this.releaseRecord(state);
    return true;
  }

  private async acquireRecord(
    conversationId: string,
    busy: 'throw' | 'return'
  ): Promise<OwnedConversation | undefined> {
    if (this.processStartIdentity === undefined) {
      throw new ConversationRuntimeOwnerClaimError(
        'conversation-runtime-owner-unavailable',
        'This platform cannot verify the Runtime Host process start identity; conversation ownership is disabled.'
      );
    }
    const claimPath = conversationRuntimeOwnerClaimPath(this.paths, conversationId);
    const metadata: ConversationRuntimeOwnerMetadata = {
      dataSetId: this.dataSetId,
      rootInstanceId: this.rootInstanceId,
      rootGeneration: this.rootGeneration,
      conversationId,
      hostBootId: this.hostBootId,
      ownerToken: randomUUID(),
      processId: this.processId,
      processStartIdentity: this.processStartIdentity,
      startedAt: new Date().toISOString()
    };
    await fs.mkdir(path.dirname(claimPath), { recursive: true, mode: 0o700 });
    for (;;) {
      if (this.closed) throw closedManagerError();
      await this.assertBindingCurrent();
      if (await tryPublishClaimRecord(
        claimPath,
        CONVERSATION_RUNTIME_OWNER_RECORD_FILE,
        `${JSON.stringify(metadata)}\n`
      )) {
        return { conversationId, claimPath, ownerToken: metadata.ownerToken, pins: 0 };
      }
      const record = await this.readRecord(claimPath);
      if (!record) continue;
      if (record.conversationId !== conversationId) {
        throw new ConversationRuntimeOwnerClaimError(
          'conversation-runtime-owner-invalid',
          `Conversation Runtime owner record names a different conversation: ${claimPath}`
        );
      }
      // Only a definitely dead or reused process identity may be isolated. Any live or unknown
      // state — including mismatched root identity, a record from this same process, or an
      // elapsed heartbeat — fails closed: none of those prove the recorded writer is fenced.
      if (classifyRecordedProcess(record.processId, record.processStartIdentity) === 'dead') {
        await this.isolateRecord(claimPath, record.ownerToken);
        continue;
      }
      if (busy === 'return') return undefined;
      throw new ConversationRuntimeOwnerBusyError(conversationId, record);
    }
  }

  /**
   * Claim-boundary fence: the manager holds an immutable RootBinding and no RootAuthority, so
   * before any publication it proves the RootBinding pointer still names this exact root
   * generation. A stale manager can otherwise publish or isolate records inside a freshly
   * rebound control tree; failing closed here keeps new-root availability unaffected. This runs
   * only per claim attempt — never per streamed execution event.
   */
  private async assertBindingCurrent(): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(this.paths.rootPointerPath, 'utf8')) as unknown;
    } catch (error) {
      throw new ConversationRuntimeOwnerClaimError(
        'conversation-runtime-owner-unavailable',
        `RootBinding pointer cannot be read for conversation ownership: ${this.paths.rootPointerPath}`,
        error
      );
    }
    let pointer: RootBinding;
    try {
      pointer = parseRootBinding(value);
    } catch (error) {
      throw new ConversationRuntimeOwnerClaimError(
        'conversation-runtime-owner-invalid',
        `RootBinding pointer is invalid: ${this.paths.rootPointerPath}`,
        error
      );
    }
    if (
      pointer.dataSetId !== this.dataSetId
      || pointer.rootInstanceId !== this.rootInstanceId
      || pointer.rootGeneration !== this.rootGeneration
      || pointer.paths.dataRootPath !== this.paths.dataRootPath
      || pointer.paths.rootPointerPath !== this.paths.rootPointerPath
    ) {
      throw new ConversationRuntimeOwnerClaimError(
        'conversation-runtime-owner-unavailable',
        'The Runtime root was rebound; this Runtime Host’s conversation ownership is fenced.'
      );
    }
  }

  private readRecord(claimPath: string): Promise<ConversationRuntimeOwnerMetadata | undefined> {
    return readClaimRecord(claimPath, CONVERSATION_RUNTIME_OWNER_RECORD_FILE, parseOwnerMetadata, (cause) =>
      new ConversationRuntimeOwnerClaimError(
        'conversation-runtime-owner-invalid',
        `Conversation Runtime owner record is invalid: ${claimPath}`,
        cause
      ));
  }

  private isolateRecord(claimPath: string, ownerToken: string): Promise<void> {
    return isolateDeadClaimRecord(claimPath, CONVERSATION_RUNTIME_OWNER_RECORD_FILE, ownerToken, parseOwnerMetadata, (cause) =>
      new ConversationRuntimeOwnerClaimError(
        'conversation-runtime-owner-invalid',
        `Conversation Runtime owner record is invalid: ${claimPath}`,
        cause
      ));
  }

  private releaseRecord(state: OwnedConversation): Promise<void> {
    return releaseClaimRecord(
      state.claimPath,
      CONVERSATION_RUNTIME_OWNER_RECORD_FILE,
      state.ownerToken,
      parseOwnerMetadata,
      (cause) => new ConversationRuntimeOwnerClaimError(
        'conversation-runtime-owner-invalid',
        `Conversation Runtime owner record is invalid: ${state.claimPath}`,
        cause
      ),
      () => new ConversationRuntimeOwnerClaimError(
        'conversation-runtime-owner-mismatch',
        `Conversation ${state.conversationId} is no longer owned by token ${state.ownerToken}.`
      )
    );
  }
}

function parseOwnerMetadata(value: unknown): ConversationRuntimeOwnerMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  const expected = [
    'conversationId', 'dataSetId', 'hostBootId', 'ownerToken', 'processId',
    'processStartIdentity', 'rootGeneration', 'rootInstanceId', 'startedAt'
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.dataSetId !== 'string' || record.dataSetId.length === 0
    || typeof record.rootInstanceId !== 'string' || record.rootInstanceId.length === 0
    || !Number.isSafeInteger(record.rootGeneration) || (record.rootGeneration as number) <= 0
    || typeof record.conversationId !== 'string' || record.conversationId.length === 0
    || typeof record.hostBootId !== 'string' || record.hostBootId.length === 0
    || typeof record.ownerToken !== 'string' || record.ownerToken.length === 0
    || !Number.isSafeInteger(record.processId) || (record.processId as number) <= 0
    || typeof record.processStartIdentity !== 'string' || record.processStartIdentity.length === 0
    || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
  ) return undefined;
  return value as unknown as ConversationRuntimeOwnerMetadata;
}

function closedManagerError(): ConversationRuntimeOwnerClaimError {
  return new ConversationRuntimeOwnerClaimError(
    'conversation-runtime-owner-closed',
    'Conversation Runtime owner manager is closed.'
  );
}

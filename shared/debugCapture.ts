export interface DebugCaptureSettings {
  scope: 'conversation' | 'workspace';
  maxMiB: 8 | 16 | 32;
  maxMinutes: 5 | 15 | 30;
}

export const DEBUG_CAPTURE_LIMITS = {
  totalBytes: 128 * 1_048_576,
  maxRuns: 16,
  memoryBytes: 4 * 1_048_576,
  reserveBytes: 256 * 1_024,
  flushMs: 1_000
} as const;

export function normalizeDebugCaptureSettings(input?: Partial<DebugCaptureSettings>): DebugCaptureSettings {
  return {
    scope: input?.scope === 'workspace' ? 'workspace' : 'conversation',
    maxMiB: input?.maxMiB === 8 || input?.maxMiB === 16 ? input.maxMiB : 32,
    maxMinutes: input?.maxMinutes === 5 || input?.maxMinutes === 15 ? input.maxMinutes : 30
  };
}

export interface DebugCaptureTarget {
  scope: DebugCaptureSettings['scope'];
  conversationId?: string;
}

export type DebugCaptureStopReason =
  | 'user' | 'time_limit' | 'size_limit' | 'memory_limit' | 'write_failed'
  | 'root_changed' | 'host_closed' | 'interrupted';

export interface DebugCaptureManifest {
  runId: string;
  commandId: string;
  commandAliases: string[];
  target: DebugCaptureTarget;
  maxBytes: number;
  maxDurationMs: number;
  startedAt: string;
  stoppedAt?: string;
  status: 'recording' | 'stopping' | 'sealed';
  stopReason?: DebugCaptureStopReason;
  hasGaps: boolean;
  gapReason?: string;
  lastAcceptedSeq: number;
  durableSeq: number;
  payloadBytes: number;
  indexBytes: number;
  acceptedBytes: number;
  peakMemoryBytes: number;
  batches: number;
  elapsedMs: number;
  source: { extensionVersion: string; sourceCommit: string; hostBootId: string; buildId: string };
}

export interface DebugPayloadRef {
  offset: number;
  length: number;
  sha256: string;
  encoding: 'bytes' | 'json';
}

export interface DebugCaptureSourceRef {
  runId: string;
  captureSeq: number;
  byteStart?: number;
  byteEnd?: number;
}

export interface DebugCaptureContext {
  conversationId: string;
  modelRequestId: string;
  attemptSeq?: number | string;
  socketGeneration?: number | string;
}

export interface DebugCaptureEvent {
  runId: string;
  captureSeq: number;
  observedAt: string;
  elapsedMs: number;
  stage: string;
  context?: DebugCaptureContext;
  sources: DebugCaptureSourceRef[];
  metadata: Record<string, string | number | boolean | null>;
  payload?: DebugPayloadRef;
}

export interface DebugCaptureAnalysis {
  runId: string;
  capturedSource: DebugCaptureManifest['source'];
  analyzerSource: DebugCaptureManifest['source'];
  versionMatches: boolean;
  integrity: string[];
  findings: Array<{ level: 'evidence' | 'inference' | 'unknown'; sequence: number; message: string }>;
  events: number;
  tools: Array<{ requestId: string; callId: string; characters: number; completed: boolean }>;
  truncated: boolean;
}

export type DebugCaptureSummary = Omit<DebugCaptureManifest, 'source' | 'commandId' | 'commandAliases'>;
export interface DebugCaptureState {
  active?: DebugCaptureSummary;
  runs: DebugCaptureSummary[];
  directory: string;
  totalBytes: number;
  error?: string;
}

export type DebugCaptureCommand =
  | { action: 'status' }
  | { action: 'start'; commandId: string; conversationId?: string }
  | { action: 'stop'; runId: string }
  | { action: 'open' | 'export' | 'analyze' | 'delete'; runId: string };

export interface DebugCaptureResult {
  state: DebugCaptureState;
  analysis?: DebugCaptureAnalysis;
}

export const DEBUG_CAPTURE_UI_LIMITS = { batchBytes: 128 * 1024, queueBytes: 256 * 1024, events: 128, ackMs: 5000 } as const;
export interface DebugCaptureUiEvent {
  stage: 'ui.frame' | 'ui.tool_apply' | 'ui.tool_baseline' | 'ui.snapshot';
  context: DebugCaptureContext;
  observedAt: string;
  metadata: Record<string, string | number | boolean | null>;
  payload?: unknown;
}
export interface DebugCaptureUiBatch {
  runId: string;
  viewId: string;
  batchSeq: number;
  events: DebugCaptureUiEvent[];
  gap?: string;
}
export interface DebugCaptureUiAck { runId: string; viewId: string; batchSeq: number; accepted: boolean; }

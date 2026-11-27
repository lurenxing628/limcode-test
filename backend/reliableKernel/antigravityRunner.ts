import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Runs one agy CLI turn for the antigravity tool inside an ordinary reliable background process.
 * The dispatcher starts this file with the extension's own Node runtime and pipes the launch request
 * (base64 JSON) to stdin, so the shell command never carries the prompt as an argument. agy's
 * stream-json events become short progress lines on stdout; the final answer and a footer come last
 * so they stay inside the tail a background completion delivers. Only Node built-ins are used: the
 * dispatcher imports this module for its path, and running it must not load the kernel.
 */
export const ANTIGRAVITY_RUNNER_FILE = __filename;

export interface AntigravityRunnerRequest {
  agyPath: string;
  prompt: string;
  model: string;
  conversationId?: string;
  cwd: string;
  logDirectory?: string;
}

/** Above this many characters the task goes through a file: Windows caps a command line near 32K. */
export const ANTIGRAVITY_INLINE_PROMPT_MAX_CHARS = 20_000;
/** Answers longer than this lose their head in the delivered tail, so the footer points to the file. */
const ANSWER_TAIL_NOTICE_BYTES = 5_000;
const PROGRESS_TEXT_MAX_CHARS = 160;
const STDERR_TAIL_MAX_CHARS = 1_500;

const NO_QUESTIONS_PREFIX = [
  '你是被另一个 Agent 调用的子 Agent，没有人会回答你的提问。',
  '遇到不确定的地方，自己做出合理假设并继续完成任务，不要停下来提问或等待确认；',
  '在最终答复里列出你做了哪些假设、改了哪些文件、怎样验证的。',
  ''
].join('\n');

export function encodeAntigravityRunnerRequest(request: AntigravityRunnerRequest): string {
  return Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
}

export function decodeAntigravityRunnerRequest(encoded: string): AntigravityRunnerRequest {
  const parsed = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8')) as Partial<AntigravityRunnerRequest>;
  if (!parsed || typeof parsed !== 'object') throw new Error('Antigravity 启动参数无效。');
  for (const key of ['agyPath', 'prompt', 'model', 'cwd'] as const) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`Antigravity 启动参数缺少 ${key}。`);
  }
  if (parsed.conversationId !== undefined && typeof parsed.conversationId !== 'string') {
    throw new Error('Antigravity 启动参数 conversationId 无效。');
  }
  return parsed as AntigravityRunnerRequest;
}

/** agy argv for one turn; a long task is written to a file that agy is told to read first. */
export function antigravityAgyArguments(
  request: AntigravityRunnerRequest,
  writeTaskFile: (text: string) => string
): string[] {
  const fullPrompt = `${NO_QUESTIONS_PREFIX}${request.prompt}`;
  const prompt = fullPrompt.length <= ANTIGRAVITY_INLINE_PROMPT_MAX_CHARS
    ? fullPrompt
    : `${NO_QUESTIONS_PREFIX}任务内容较长，已写入文件：${writeTaskFile(request.prompt)}\n先完整读取这个文件，再按其中的要求完成任务。`;
  return [
    '-p', prompt,
    '--model', request.model,
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    ...(request.conversationId ? ['--conversation', request.conversationId] : [])
  ];
}

interface StepState {
  index: number;
  type: string;
  toolName?: string;
  announced: boolean;
  text: string;
}

export interface AntigravityRunSummary {
  conversationId?: string;
  status?: string;
  response?: string;
  durationSeconds?: number;
  turns?: number;
  usage?: Record<string, unknown>;
  changedFiles: string[];
  errors: string[];
}

/**
 * Turns agy stream-json events into progress lines. Pure so tests can feed recorded events; time is
 * the caller's elapsed seconds for each line.
 */
export class AntigravityEventReporter {
  public readonly summary: AntigravityRunSummary = { changedFiles: [], errors: [] };
  private readonly steps = new Map<number, StepState>();

  public constructor(private readonly write: (line: string) => void) {}

  public handleLine(line: string, elapsedSeconds: number): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) return;
      event = parsed;
    } catch {
      this.write(`${stamp(elapsedSeconds)} ${oneLine(trimmed)}`);
      return;
    }
    if (typeof event.conversation_id === 'string' && event.conversation_id) {
      this.summary.conversationId = event.conversation_id;
    }
    if (event.event === 'init') {
      const init = isRecord(event.init) ? event.init : {};
      const model = typeof init.model === 'string' ? init.model : '';
      this.write(`${stamp(elapsedSeconds)} 已启动 Antigravity${model ? ` · ${model}` : ''}${this.summary.conversationId ? ` · 对话 ${this.summary.conversationId}` : ''}`);
      return;
    }
    if (event.event === 'step_update' && isRecord(event.step_update)) {
      this.handleStep(event.step_update, elapsedSeconds);
      return;
    }
    if (event.event === 'result' && isRecord(event.result)) {
      const result = event.result;
      if (typeof result.conversation_id === 'string' && result.conversation_id) this.summary.conversationId = result.conversation_id;
      this.summary.status = typeof result.status === 'string' ? result.status : 'UNKNOWN';
      this.summary.response = typeof result.response === 'string' ? result.response : '';
      if (typeof result.duration_seconds === 'number') this.summary.durationSeconds = result.duration_seconds;
      if (typeof result.num_turns === 'number') this.summary.turns = result.num_turns;
      if (isRecord(result.usage)) this.summary.usage = result.usage;
      return;
    }
    if (event.event === 'error') {
      const message = errorText(event.error ?? event.message ?? event);
      this.summary.errors.push(message);
      this.write(`${stamp(elapsedSeconds)} 出错：${message}`);
    }
  }

  private handleStep(update: Record<string, unknown>, elapsedSeconds: number): void {
    const index = typeof update.step_index === 'number' ? update.step_index : -1;
    const type = typeof update.step_type === 'string' ? update.step_type : '';
    if (type === 'user_input' || type === 'system_message') return;
    let step = this.steps.get(index);
    if (!step) {
      step = { index, type, announced: false, text: '' };
      this.steps.set(index, step);
    }
    const toolInfo = isRecord(update.tool_info) ? update.tool_info : undefined;
    const toolName = typeof update.tool_name === 'string' && update.tool_name
      ? update.tool_name
      : typeof toolInfo?.name === 'string' ? toolInfo.name : undefined;
    if (toolName) step.toolName = toolName;
    if (typeof update.text_delta === 'string') step.text += update.text_delta;
    const state = typeof update.state === 'string' ? update.state : '';
    const label = `${stamp(elapsedSeconds)} 第${index + 1}步`;
    if (type === 'tool') {
      const parameters = isRecord(toolInfo?.parameters) ? toolInfo.parameters : undefined;
      if (!step.announced && (parameters || state === 'DONE' || state === 'ERROR')) {
        step.announced = true;
        const detail = toolDetail(parameters);
        this.write(`${label} ${step.toolName ?? '工具'}${detail ? `: ${detail}` : ''}`);
        const changedPath = changedFilePath(step.toolName, parameters);
        if (changedPath && !this.summary.changedFiles.includes(changedPath)) this.summary.changedFiles.push(changedPath);
      }
      if (state === 'ERROR') {
        const output = toolInfo?.output === undefined ? '' : errorText(toolInfo.output);
        this.write(`${label} ${step.toolName ?? '工具'} 出错${output ? `：${output}` : ''}`);
      }
      return;
    }
    if (type === 'agent_response' && state === 'DONE' && !step.announced) {
      step.announced = true;
      const text = oneLine(step.text);
      if (text) this.write(`${label} 回复：${text}`);
    }
    if (state === 'ERROR' && type !== 'tool') {
      const message = errorText(update.error ?? update.text_delta ?? '步骤失败');
      this.summary.errors.push(message);
      this.write(`${label} 出错：${message}`);
    }
  }
}

/** The final block: answer first, then a footer that always fits inside the delivered tail. */
export function antigravityFinalReport(input: {
  summary: AntigravityRunSummary;
  model: string;
  exitCode: number | null;
  stderrTail: string;
  answerPath?: string;
  logPath?: string;
}): string {
  const { summary } = input;
  const lines: string[] = [];
  const succeeded = summary.status === 'SUCCESS';
  if (summary.response !== undefined) {
    lines.push('', '==== Antigravity 最终答复 ====', summary.response.trimEnd() || '（答复为空）');
  } else {
    lines.push('', '==== Antigravity 没有给出最终答复 ====');
    if (input.stderrTail.trim()) lines.push(`agy 错误输出（末尾）：\n${input.stderrTail.trim()}`);
  }
  lines.push('', '==== 运行信息 ====');
  lines.push(`状态：${summary.status ?? '未完成'}${input.exitCode !== null && input.exitCode !== 0 ? ` · agy 退出码 ${input.exitCode}` : ''} · 模型 ${input.model}`);
  const stats = [
    summary.durationSeconds !== undefined ? `用时 ${Math.round(summary.durationSeconds)} 秒` : '',
    summary.turns !== undefined ? `${summary.turns} 轮` : '',
    usageText(summary.usage)
  ].filter(Boolean);
  if (stats.length > 0) lines.push(stats.join(' · '));
  if (summary.conversationId) {
    lines.push(`agy 对话 ID：${summary.conversationId}（要继续这段对话，用 operation=send 并传 agyConversationId）`);
  }
  if (summary.changedFiles.length > 0) {
    const shown = summary.changedFiles.slice(0, 30);
    lines.push(`写入或编辑过的文件：${shown.join(', ')}${summary.changedFiles.length > shown.length ? ` 等 ${summary.changedFiles.length} 个` : ''}`);
  }
  if (summary.response && Buffer.byteLength(summary.response, 'utf8') > ANSWER_TAIL_NOTICE_BYTES && input.answerPath) {
    lines.push(`答复较长，完成通知里只带了末尾；完整答复见文件：${input.answerPath}`);
  } else if (input.answerPath && summary.response) {
    lines.push(`完整答复文件：${input.answerPath}`);
  }
  if (input.logPath) lines.push(`agy 原始事件日志：${input.logPath}`);
  if (!succeeded) lines.push('agy 没有成功完成，请检查上面的进度和错误输出后再决定是否重试。');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<number> {
  const request = decodeAntigravityRunnerRequest(await readStdin());
  const logDirectory = request.logDirectory ?? path.join(os.tmpdir(), 'limcode-antigravity');
  fs.mkdirSync(logDirectory, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const logPath = path.join(logDirectory, `${runId}.ndjson`);
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const startedAt = Date.now();
  const elapsed = () => (Date.now() - startedAt) / 1000;
  const reporter = new AntigravityEventReporter((line) => process.stdout.write(`${line}\n`));
  const args = antigravityAgyArguments(request, (text) => {
    const taskPath = path.join(logDirectory, `${runId}-task.md`);
    fs.writeFileSync(taskPath, text, 'utf8');
    return taskPath;
  });
  process.stdout.write(`${stamp(0)} 正在启动 agy · 模型 ${request.model}${request.conversationId ? ` · 继续对话 ${request.conversationId}` : ''}\n`);

  let stderrTail = '';
  const exitCode = await new Promise<number | null>((resolve) => {
    // A JavaScript entry (an npm-installed agy shim, or a test double) runs on this same Node runtime.
    const [executable, prefix] = /\.[cm]?js$/i.test(request.agyPath)
      ? [process.execPath, [request.agyPath]]
      : [request.agyPath, []];
    const child = spawn(executable, [...prefix, ...args], {
      cwd: request.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      log.write(chunk);
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        reporter.handleLine(pending.slice(0, newline), elapsed());
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_MAX_CHARS);
    });
    child.once('error', (error) => {
      stderrTail = `${stderrTail}\n无法启动 agy：${error.message}`.slice(-STDERR_TAIL_MAX_CHARS);
      resolve(null);
    });
    child.once('close', (code) => {
      if (pending.trim()) reporter.handleLine(pending, elapsed());
      resolve(code);
    });
    // A stop from limcode ends this runner; take agy down with it instead of leaving it running.
    const forward = () => { try { child.kill(); } catch { /* already gone */ } };
    process.once('SIGTERM', forward);
    process.once('SIGINT', forward);
  });
  await new Promise<void>((resolve) => log.end(resolve));

  let answerPath: string | undefined;
  if (reporter.summary.response) {
    answerPath = path.join(logDirectory, `${runId}-answer.md`);
    fs.writeFileSync(answerPath, reporter.summary.response, 'utf8');
  }
  process.stdout.write(antigravityFinalReport({
    summary: reporter.summary,
    model: request.model,
    exitCode,
    stderrTail,
    answerPath,
    logPath
  }));
  return reporter.summary.status === 'SUCCESS' && exitCode === 0 ? 0 : 1;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { text += chunk; });
    process.stdin.once('end', () => resolve(text));
    process.stdin.once('error', reject);
  });
}

function stamp(seconds: number): string {
  return `[${Math.max(0, Math.round(seconds))}s]`;
}

function oneLine(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > PROGRESS_TEXT_MAX_CHARS ? `${normalized.slice(0, PROGRESS_TEXT_MAX_CHARS - 1)}…` : normalized;
}

function toolDetail(parameters: Record<string, unknown> | undefined): string {
  if (!parameters) return '';
  for (const key of ['CommandLine', 'command', 'Path', 'path', 'AbsolutePath', 'TargetFile', 'FilePath', 'file_path', 'Query', 'query', 'Url', 'url']) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  return '';
}

function changedFilePath(toolName: string | undefined, parameters: Record<string, unknown> | undefined): string | undefined {
  if (!toolName || !parameters || !/write|edit|replace|create/i.test(toolName)) return undefined;
  for (const key of ['Path', 'path', 'AbsolutePath', 'TargetFile', 'FilePath', 'file_path']) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function usageText(usage: Record<string, unknown> | undefined): string {
  if (!usage) return '';
  const parts = [
    ['输入', usage.input_tokens],
    ['输出', usage.output_tokens],
    ['思考', usage.thinking_tokens],
    ['缓存读取', usage.cache_read_tokens]
  ].filter(([, value]) => typeof value === 'number' && value > 0)
    .map(([label, value]) => `${label} ${value as number}`);
  return parts.length > 0 ? `Token：${parts.join(' / ')}` : '';
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return oneLine(value);
  if (isRecord(value) && typeof value.message === 'string') return oneLine(value.message);
  try { return oneLine(JSON.stringify(value)); } catch { return String(value); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stdout.write(`Antigravity 运行器失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import type Database from 'better-sqlite3';
import { isSamePath } from '../capabilities/filesystem/pathContainment';
import type { RootBinding } from './contracts';
import type { PhaseDEffectKind } from './effectControlPlane';
import { prepareCached } from './runtimeStatementCache';

/**
 * Content usage by type (历史与存储管理 → 查看存储占用, and inspectReliability): ContentObject
 * metadata aggregated per content_type by the RuntimeDatabase worker of the selected data set.
 *
 * The aggregate runs on the worker's reader connection and reads only the covering unique index
 * (content_type, sha256, byte_length) in index order: no temporary B-tree, no table row and no CAS
 * file; its WAL read snapshot never blocks writers. Figures are per ContentObject record: bytes
 * that one CAS file carries under several content types count once per type, so the sums can
 * exceed the CAS directory that the storage inspection walks. A per-sha256 deduplicated total
 * would need a temporary B-tree and is deliberately not computed.
 */
export const RUNTIME_CONTENT_USAGE_SQL =
  'SELECT content_type, COUNT(*), SUM(byte_length), MAX(byte_length) FROM content_object GROUP BY content_type';

/** Count, byte sum and largest record; decimal text keeps JSON and structured clone exact. */
export interface RuntimeContentUsageFigures {
  count: string;
  bytes: string;
  maxBytes: string;
}

/** ContentObject records of one exact content_type value. */
export interface RuntimeContentUsageRow extends RuntimeContentUsageFigures {
  contentType: string;
}

export type RuntimeContentUsageCategoryKey =
  | 'message'
  | 'modelRequestRecipe'
  | 'contextHandleCatalog'
  | 'modelStreamCheckpoint'
  | 'contextToolPair'
  | 'toolArguments'
  | 'toolCallEvent'
  | 'toolModelResult'
  | 'toolResultArtifact'
  | 'effectRequest'
  | 'effectReceipt'
  | 'processOutput'
  | 'compression'
  | 'attachment'
  | 'childDelivery'
  | 'interaction'
  | 'settingsSnapshot'
  | 'sharedText'
  | 'other';

export interface RuntimeContentTypeClass {
  category: RuntimeContentUsageCategoryKey;
  /** Chinese name of the type; views append the type itself. */
  label: string;
}

export interface RuntimeContentUsageType extends RuntimeContentUsageRow {
  label: string;
}

export interface RuntimeContentUsageCategory extends RuntimeContentUsageFigures {
  key: RuntimeContentUsageCategoryKey;
  label: string;
  /** What else shares these types, where a type alone cannot tell. */
  note?: string;
  /** Largest first. */
  types: RuntimeContentUsageType[];
}

export interface RuntimeContentUsageReport {
  /** One CAS file shared by several content types is counted once per type. */
  countedBy: 'content-object-record';
  total: RuntimeContentUsageFigures;
  /** Largest first; only categories that have records. */
  categories: RuntimeContentUsageCategory[];
}

/** This window's open RuntimeDatabase, as far as the storage view needs it. */
export interface RuntimeContentUsageSource {
  readonly binding: Pick<RootBinding, 'dataSetId' | 'rootInstanceId' | 'paths'>;
  contentUsage(): Promise<RuntimeContentUsageRow[]>;
}

const CATEGORIES: ReadonlyArray<{ key: RuntimeContentUsageCategoryKey; label: string; note?: string }> = [
  { key: 'message', label: '对话消息' },
  { key: 'modelRequestRecipe', label: '模型请求配方' },
  { key: 'contextHandleCatalog', label: '上下文引用目录' },
  { key: 'modelStreamCheckpoint', label: '模型流式检查点' },
  { key: 'contextToolPair', label: '上下文里的工具记录' },
  { key: 'toolArguments', label: '工具调用参数' },
  { key: 'toolCallEvent', label: '工具调用事件' },
  { key: 'toolModelResult', label: '工具结果' },
  { key: 'toolResultArtifact', label: '工具结果附件' },
  { key: 'effectRequest', label: '外部效果请求' },
  { key: 'effectReceipt', label: '外部效果回执' },
  {
    key: 'processOutput', label: '进程原始输出',
    note: 'application/octet-stream 也用于写入或删除前的原文件快照，以及未识别格式的附件。'
  },
  { key: 'compression', label: '上下文压缩' },
  { key: 'attachment', label: '附件' },
  { key: 'childDelivery', label: '子 Agent 与投递' },
  { key: 'interaction', label: '交互与审批' },
  { key: 'settingsSnapshot', label: '执行设置快照' },
  {
    key: 'sharedText', label: '通用文本（多处共用）',
    note: '用户输入、子 Agent 提示与回答、压缩标题与摘要、编辑前后的文件快照、协作看板和文本附件都可能使用这些类型。'
  },
  { key: 'other', label: '其它', note: '未归类的类型按原样列出。' }
];

const LIMCODE_TYPE_PREFIX = 'application/vnd.limcode.';

/** Every exact Runtime content type; `effect-<kind>[-receipt]+json` are matched separately. */
const KNOWN_CONTENT_TYPE_ENTRIES: ReadonlyArray<readonly [string, RuntimeContentUsageCategoryKey, string]> = [
  ['application/vnd.limcode.message+json', 'message', '消息正文'],
  ['application/vnd.limcode.turn-intent+json', 'message', '排队输入'],
  ['application/vnd.limcode.native-steer+json', 'message', '运行中插话'],
  ['application/vnd.limcode.model-request-recipe+json', 'modelRequestRecipe', '模型请求配方'],
  ['application/vnd.limcode.frozen-tool-definitions+json', 'modelRequestRecipe', '冻结工具定义'],
  ['application/vnd.limcode.fork-context-handle-reservations+json', 'modelRequestRecipe', '分叉引用保留'],
  ['application/vnd.limcode.conversation-context-handle-state+json', 'contextHandleCatalog', '对话引用目录'],
  ['application/vnd.limcode.conversation-context-handle-upgrade+json', 'contextHandleCatalog', '引用目录重建进度'],
  ['application/vnd.limcode.model-stream-checkpoint+json', 'modelStreamCheckpoint', '模型流式检查点'],
  ['application/vnd.limcode.context-tool-pair+json', 'contextToolPair', '上下文工具记录'],
  ['application/vnd.limcode.tool-arguments+json', 'toolArguments', '工具调用参数'],
  ['application/vnd.limcode.tool-call-event+json', 'toolCallEvent', '工具运行事件'],
  ['application/vnd.limcode.native-tool-admission+json', 'toolCallEvent', '原生工具调用准入'],
  ['application/vnd.limcode.native-tool-delivery+json', 'toolCallEvent', '原生工具结果送达'],
  ['application/vnd.limcode.tool-model-result+json', 'toolModelResult', '工具结果'],
  ['application/vnd.limcode.tool-result-artifact+json', 'toolResultArtifact', '工具结果附件'],
  ['application/vnd.limcode.effect-dispatch-request+json', 'effectRequest', '效果派发记录'],
  ['application/octet-stream', 'processOutput', '进程原始输出等二进制'],
  ['application/vnd.limcode.compression-contents+json', 'compression', '压缩内容'],
  ['application/vnd.limcode.attachment-observation+json', 'attachment', '附件语义观察'],
  ['application/vnd.limcode.subagent-spawn+json', 'childDelivery', '子 Agent 启动请求'],
  ['application/vnd.limcode.child-answer-resolution+json', 'childDelivery', '子 Agent 等待结果'],
  ['application/vnd.limcode.child-runtime-delivery-continuation+json', 'childDelivery', '子 Agent 投递续跑'],
  ['application/vnd.limcode.native-child-handle-projection+json', 'childDelivery', '子 Agent 句柄'],
  ['application/vnd.limcode.runtime-delivery-model+json', 'childDelivery', '投递给模型的内容'],
  ['application/vnd.limcode.process-completion+json', 'childDelivery', '进程完成投递'],
  ['application/vnd.limcode.child-answer-source-deleted+json', 'childDelivery', '子任务删除通知'],
  ['text/vnd.limcode.collaboration-message', 'childDelivery', '协作消息'],
  ['application/vnd.limcode.ask-user-prompt+json', 'interaction', '向用户提问'],
  ['application/vnd.limcode.ask-user-response+json', 'interaction', '用户回答'],
  ['application/vnd.limcode.execution-approval-prompt+json', 'interaction', '执行审批请求'],
  ['application/vnd.limcode.execution-approval-response+json', 'interaction', '执行审批结果'],
  ['application/vnd.limcode.plan-review-prompt+json', 'interaction', '计划审阅请求'],
  ['application/vnd.limcode.plan-review-response+json', 'interaction', '计划审阅结果'],
  ['application/vnd.limcode.file-change-proposal+json', 'interaction', '文件改动提案'],
  ['application/vnd.limcode.file-change-decision+json', 'interaction', '文件改动决定'],
  ['application/vnd.limcode.turn-interrupt-request+json', 'interaction', '中断请求'],
  ['application/vnd.limcode.turn-execution-preset+json', 'settingsSnapshot', '执行预设'],
  ['application/vnd.limcode.turn-authority-snapshot+json', 'settingsSnapshot', '权限快照'],
  ['application/vnd.limcode.model-request-settings+json', 'settingsSnapshot', '模型请求设置'],
  ['text/plain', 'sharedText', '纯文本'],
  ['text/markdown', 'sharedText', 'Markdown 文本'],
  ['application/json', 'sharedText', 'JSON']
];
const KNOWN_CONTENT_TYPES = new Map(KNOWN_CONTENT_TYPE_ENTRIES.map(
  ([type, category, label]): [string, RuntimeContentTypeClass] => [type, { category, label }]
));
/** The exact types above, for the source-scan completeness check. */
export const KNOWN_RUNTIME_CONTENT_TYPES: readonly string[] = KNOWN_CONTENT_TYPE_ENTRIES.map(([type]) => type);

/** A new PhaseDEffectKind fails compilation here until it has a name. */
const EFFECT_KIND_LABELS: Readonly<Record<PhaseDEffectKind, string>> = {
  file_mutation: '文件修改',
  process_start: '启动进程',
  process_exit: '进程退出',
  process_stop_request: '停止进程',
  file_transfer: '文件传输',
  subagent_spawn: '启动子 Agent',
  subagent_cancel: '取消子 Agent',
  mcp_tool_call: 'MCP 工具调用'
};

const EFFECT_CONTENT_TYPE = /^application\/vnd\.limcode\.effect-([a-z0-9_]+)(-receipt)?\+json$/;
/** RFC 6838 restricted names: `type/subtype`. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Category of one stored content_type (parameters such as `; charset=utf-8` and case ignored).
 * Every `vnd.limcode` type the code writes has an entry; any other vnd.limcode type is unknown
 * and stays in 其它. Remaining media types come from attachments (user files, tool and MCP media).
 */
export function classifyRuntimeContentType(contentType: string): RuntimeContentTypeClass {
  const base = contentType.split(';', 1)[0].trim().toLowerCase();
  const known = KNOWN_CONTENT_TYPES.get(base);
  if (known) return { ...known };
  const effect = EFFECT_CONTENT_TYPE.exec(base);
  if (effect && Object.prototype.hasOwnProperty.call(EFFECT_KIND_LABELS, effect[1])) {
    const name = EFFECT_KIND_LABELS[effect[1] as PhaseDEffectKind];
    return effect[2]
      ? { category: 'effectReceipt', label: `${name}回执` }
      : { category: 'effectRequest', label: `${name}请求` };
  }
  if (base.includes('/vnd.limcode.') || !MEDIA_TYPE.test(base)) return { category: 'other', label: '未知类型' };
  const [top] = base.split('/', 1);
  if (top === 'image') return { category: 'attachment', label: '图片' };
  if (top === 'audio') return { category: 'attachment', label: '音频' };
  if (top === 'video') return { category: 'attachment', label: '视频' };
  if (base === 'application/pdf') return { category: 'attachment', label: 'PDF 文档' };
  if (top === 'text') return { category: 'attachment', label: '文本文件' };
  return { category: 'attachment', label: '文件' };
}

/** Worker side, on the reader connection of this data set's own RuntimeDatabase worker. */
export function executeRuntimeContentUsage(reader: Database.Database): RuntimeContentUsageRow[] {
  const rows = prepareCached(reader, RUNTIME_CONTENT_USAGE_SQL, { rows: 'raw', safeIntegers: true }).all() as unknown[][];
  return rows.map(([contentType, count, bytes, maxBytes]) => {
    if (typeof contentType !== 'string') throw new TypeError('ContentObject.content_type must be text.');
    return {
      contentType,
      count: aggregateText(count, 'COUNT(*)'),
      bytes: aggregateText(bytes, 'SUM(byte_length)'),
      maxBytes: aggregateText(maxBytes, 'MAX(byte_length)')
    };
  });
}

export function summarizeRuntimeContentUsage(rows: readonly RuntimeContentUsageRow[]): RuntimeContentUsageReport {
  const total = emptyFigures();
  const categories = new Map<RuntimeContentUsageCategoryKey, RuntimeContentUsageCategory>();
  for (const row of rows) {
    if (typeof row.contentType !== 'string') throw new TypeError('Content usage contentType must be text.');
    const figures = { count: decimal(row.count), bytes: decimal(row.bytes), maxBytes: decimal(row.maxBytes) };
    const kind = classifyRuntimeContentType(row.contentType);
    let category = categories.get(kind.category);
    if (!category) {
      const definition = CATEGORIES.find((entry) => entry.key === kind.category)!;
      category = { ...definition, ...emptyFigures(), types: [] };
      categories.set(kind.category, category);
    }
    category.types.push({ contentType: row.contentType, label: kind.label, ...figures });
    addFigures(category, figures);
    addFigures(total, figures);
  }
  const order = (key: RuntimeContentUsageCategoryKey) => CATEGORIES.findIndex((entry) => entry.key === key);
  const ordered = [...categories.values()].sort((left, right) =>
    compareLargestFirst(left, right) || order(left.key) - order(right.key));
  for (const category of ordered) {
    category.types.sort((left, right) => compareLargestFirst(left, right)
      || (left.contentType < right.contentType ? -1 : left.contentType > right.contentType ? 1 : 0));
  }
  return { countedBy: 'content-object-record', total, categories: ordered };
}

/** Text of the storage view; `formatBytes` is the view's own unit formatting. */
export function formatRuntimeContentUsage(
  report: RuntimeContentUsageReport,
  formatBytes: (bytes: string) => string
): string[] {
  const lines = ['按类型统计的正文（只统计当前库，按数据库记录）：'];
  if (!report.categories.length) lines.push('还没有正文记录。');
  for (const category of report.categories) {
    lines.push(`${category.label}：${category.count} 条记录，合计 ${formatBytes(category.bytes)}，`
      + `最大单个 ${formatBytes(category.maxBytes)}`);
    if (category.note) lines.push(`  注：${category.note}`);
    for (const type of category.types) {
      lines.push(`  ${type.label}（${displayedType(type.contentType, category.key)}）：${type.count} 条，`
        + `${formatBytes(type.bytes)}，最大 ${formatBytes(type.maxBytes)}`);
    }
  }
  lines.push(
    `各类合计：${report.total.count} 条记录，${formatBytes(report.total.bytes)}`,
    '删除对话目前不会释放正文空间。',
    '这里按记录统计，同一正文被几种记录共用时会重复计入；磁盘实际占用以上方目录统计为准。'
  );
  return lines;
}

/**
 * The storage view's section: only for the selected data set, and only through this window's own
 * open RuntimeDatabase of exactly that root (another Host's database is never opened here).
 * A failed read is reported in place in words (its cause only in the log), so the directory
 * statistics above are still shown.
 */
export async function describeCurrentRuntimeContentUsage(
  dataSet: { selected: boolean; dataSetId?: string; rootInstanceId?: string; runtimeDataRootPath: string },
  database: RuntimeContentUsageSource | undefined,
  formatBytes: (bytes: string) => string
): Promise<string[]> {
  if (!dataSet.selected) return ['', '按类型统计正文只对当前库提供。'];
  if (!database || !opensDataSet(database.binding, dataSet)) {
    return ['', '按类型统计正文要经本窗口已打开的当前库读取；本窗口还没有打开它，暂时无法统计。'];
  }
  try {
    return ['', ...formatRuntimeContentUsage(summarizeRuntimeContentUsage(await database.contentUsage()), formatBytes)];
  } catch (error) {
    // Its own text only goes to the log.
    console.warn('[LimCode] 按类型统计正文失败。', error);
    return ['', '按类型统计正文失败（详细原因已写入日志），稍后再打开一次试试。'];
  }
}

function opensDataSet(
  binding: RuntimeContentUsageSource['binding'],
  dataSet: { dataSetId?: string; rootInstanceId?: string; runtimeDataRootPath: string }
): boolean {
  return binding.dataSetId === dataSet.dataSetId
    && binding.rootInstanceId === dataSet.rootInstanceId
    && isSamePath(binding.paths.dataRootPath, dataSet.runtimeDataRootPath);
}

/** Known Runtime types by their distinctive suffix; anything else exactly as stored. */
function displayedType(contentType: string, category: RuntimeContentUsageCategoryKey): string {
  const shown = category !== 'other' && contentType.startsWith(LIMCODE_TYPE_PREFIX)
    ? contentType.slice(LIMCODE_TYPE_PREFIX.length)
    : contentType;
  // One line per type even for a malformed stored value.
  return shown.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function aggregateText(value: unknown, label: string): string {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`ContentObject ${label} must be a non-negative integer.`);
  return value.toString();
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError('Content usage figures must be non-negative decimal text.');
  }
  return value;
}

function emptyFigures(): RuntimeContentUsageFigures {
  return { count: '0', bytes: '0', maxBytes: '0' };
}

function addFigures(target: RuntimeContentUsageFigures, figures: RuntimeContentUsageFigures): void {
  target.count = (BigInt(target.count) + BigInt(figures.count)).toString();
  target.bytes = (BigInt(target.bytes) + BigInt(figures.bytes)).toString();
  if (BigInt(figures.maxBytes) > BigInt(target.maxBytes)) target.maxBytes = figures.maxBytes;
}

function compareLargestFirst(left: RuntimeContentUsageFigures, right: RuntimeContentUsageFigures): number {
  const bytes = BigInt(right.bytes) - BigInt(left.bytes);
  if (bytes !== 0n) return bytes > 0n ? 1 : -1;
  const count = BigInt(right.count) - BigInt(left.count);
  return count === 0n ? 0 : count > 0n ? 1 : -1;
}

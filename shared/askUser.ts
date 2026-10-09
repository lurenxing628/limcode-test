import type {
  AskUserAnswerRecord,
  AskUserOptionRecord,
  AskUserToolOutputRecord,
  AskUserToolRequestRecord
} from './protocol';
import { isEmptyToolArgument, ToolArgumentError } from './toolArgumentUtils';

export const ASK_USER_MIN_OPTIONS = 1;
export const ASK_USER_MAX_OPTIONS = 8;
export const ASK_USER_MAX_QUESTION_LENGTH = 2_000;
export const ASK_USER_MAX_OPTION_LABEL_LENGTH = 200;
export const ASK_USER_MAX_OPTION_DESCRIPTION_LENGTH = 500;
export const ASK_USER_MAX_CUSTOM_ANSWER_LENGTH = 4_000;

/** 后台无可交互前端时，对 ask_user 使用的显式系统回答。 */
export const BACKGROUND_ASK_USER_AUTO_ANSWER = '系统自动回复：请根据现有上下文自行选择最优方案并继续执行，无需等待用户确认。';

/** 把模型工具参数规范化为前后端共用的 Ask User 请求。自定义回答固定可用。 */
export function normalizeAskUserToolRequest(value: unknown): AskUserToolRequestRecord {
  const record = asRecord(parseJsonValue(value));
  if (!record) throw new ToolArgumentError('ask_user arguments must be an object');

  const question = requiredText(record.question, 'question', ASK_USER_MAX_QUESTION_LENGTH);
  if (!Array.isArray(record.options)) throw new ToolArgumentError('options must be an array');
  if (record.options.length < ASK_USER_MIN_OPTIONS || record.options.length > ASK_USER_MAX_OPTIONS) {
    throw new ToolArgumentError(`options must contain ${ASK_USER_MIN_OPTIONS} to ${ASK_USER_MAX_OPTIONS} items`);
  }

  const options = record.options.map((option, index) => normalizeOption(option, index));
  const optionLabels = new Set<string>();
  for (const option of options) {
    if (optionLabels.has(option.label)) throw new ToolArgumentError(`option labels must be unique: ${option.label}`);
    optionLabels.add(option.label);
  }

  if (!isEmptyToolArgument(record.multiple)
    && !(typeof record.multiple === 'string' && !record.multiple.trim())
    && typeof record.multiple !== 'boolean') {
    throw new ToolArgumentError('multiple must be a boolean');
  }

  return {
    question,
    options,
    multiple: record.multiple === true
  };
}

export function askUserRequestFromArgs(value: unknown): AskUserToolRequestRecord | undefined {
  try {
    return normalizeAskUserToolRequest(value);
  } catch {
    return undefined;
  }
}

export function normalizeAskUserAnswer(value: unknown): AskUserAnswerRecord {
  const record = asRecord(value);
  if (!record) throw new Error('answer must be an object');
  if (!Array.isArray(record.selectedOptionIndexes)) {
    throw new Error('answer.selectedOptionIndexes must be an array');
  }

  const selectedOptionIndexes: number[] = [];
  const seenIndexes = new Set<number>();
  for (const [position, rawIndex] of record.selectedOptionIndexes.entries()) {
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0) {
      throw new Error(`answer.selectedOptionIndexes[${position}] must be a non-negative integer`);
    }
    if (seenIndexes.has(rawIndex)) continue;
    seenIndexes.add(rawIndex);
    selectedOptionIndexes.push(rawIndex);
  }
  selectedOptionIndexes.sort((left, right) => left - right);

  const customText = optionalLimitedText(record.customText, 'answer.customText', ASK_USER_MAX_CUSTOM_ANSWER_LENGTH);
  return {
    selectedOptionIndexes,
    ...(customText ? { customText } : {})
  };
}

/** 校验回答属于该请求，并生成写入 ToolState.result 的结构化工具输出。 */
export function resolveAskUserAnswer(request: AskUserToolRequestRecord, value: unknown): AskUserToolOutputRecord {
  const answer = normalizeAskUserAnswer(value);
  for (const index of answer.selectedOptionIndexes) {
    if (index >= request.options.length) throw new Error(`unknown option index: ${index}`);
  }

  if (!request.multiple) {
    if (answer.selectedOptionIndexes.length > 1) throw new Error('single-choice questions accept only one option');
    if (answer.selectedOptionIndexes.length > 0 && answer.customText) {
      throw new Error('single-choice questions cannot combine an option with a custom answer');
    }
  }
  if (answer.selectedOptionIndexes.length === 0 && !answer.customText) {
    throw new Error('select at least one option or provide a custom answer');
  }

  return {
    kind: 'ask_user.result',
    question: request.question,
    multiple: request.multiple,
    selectedOptions: answer.selectedOptionIndexes.map((index) => ({ ...request.options[index]! })),
    ...(answer.customText ? { customText: answer.customText } : {})
  };
}

/** 从 ToolResultArtifact 投影出的模型结果（含标准 { ok, output } envelope）中读取已回答结果。 */
export function askUserOutputFromResult(value: unknown): AskUserToolOutputRecord | undefined {
  const envelope = asRecord(value);
  const rawOutput = envelope && 'output' in envelope ? envelope.output : value;
  const output = asRecord(rawOutput);
  if (!output || output.kind !== 'ask_user.result' || typeof output.question !== 'string' || typeof output.multiple !== 'boolean') {
    return undefined;
  }
  if (!Array.isArray(output.selectedOptions)) return undefined;

  const selectedOptions: AskUserOptionRecord[] = [];
  for (const rawOption of output.selectedOptions) {
    const option = outputOption(rawOption);
    if (!option) return undefined;
    selectedOptions.push(option);
  }
  const customText = optionalText(output.customText);
  if (selectedOptions.length === 0 && !customText) return undefined;

  return {
    kind: 'ask_user.result',
    question: output.question,
    multiple: output.multiple,
    selectedOptions,
    ...(customText ? { customText } : {})
  };
}

export function askUserOptionKey(option: AskUserOptionRecord): string {
  return `${option.label}\u0000${option.description ?? ''}`;
}

function normalizeOption(value: unknown, index: number): AskUserOptionRecord {
  const record = asRecord(value);
  if (!record) throw new ToolArgumentError(`options[${index}] must be an object`);
  const label = requiredText(record.label, `options[${index}].label`, ASK_USER_MAX_OPTION_LABEL_LENGTH);
  const description = optionalLimitedText(record.description, `options[${index}].description`, ASK_USER_MAX_OPTION_DESCRIPTION_LENGTH);
  return {
    label,
    ...(description ? { description } : {})
  };
}

function outputOption(value: unknown): AskUserOptionRecord | undefined {
  const record = asRecord(value);
  const label = optionalText(record?.label);
  if (!label) return undefined;
  const description = optionalText(record?.description);
  return { label, ...(description ? { description } : {}) };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ToolArgumentError('ask_user arguments must be valid JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ToolArgumentError(`${label} must be a non-empty string`);
  const text = value.trim();
  if (!text) throw new ToolArgumentError(`${label} must be a non-empty string`);
  if (text.length > maxLength) throw new ToolArgumentError(`${label} must not exceed ${maxLength} characters`);
  return text;
}

function optionalLimitedText(value: unknown, label: string, maxLength: number): string | undefined {
  if (isEmptyToolArgument(value)) return undefined;
  if (typeof value !== 'string') throw new ToolArgumentError(`${label} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new ToolArgumentError(`${label} must not exceed ${maxLength} characters`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

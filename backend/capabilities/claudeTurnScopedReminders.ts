/**
 * Claude 每轮提醒改用轮内系统消息（turn-scoped mid-conversation system messages）。
 *
 * 官方依据（https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages，
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking）：
 * - 每轮提醒写成 `{"role":"system","clear_at":"next_user_message","content":"..."}`，追加在 tool_result（或 user）
 *   消息之后；之前发过的副本原样留在原位。之后出现 user 消息（只带 tool_result 的也算）时它被清除：
 *   仍在数组里，但不显示、不计 token，因此前缀不变，缓存继续命中，Opus 5.5 / Fable 5.1 的思考块也保持有效。
 * - “Re-send cleared messages verbatim”：重建、删除或改 clear_at 都等于改了更早的消息。
 * - 需要 beta 头 `mid-conversation-system-clear-at-2026-08-21`，否则 `messages.N.clear_at: Extra inputs are not permitted`。
 * - 位置：必须紧跟 user 轮，后面只能是 assistant 轮或数组结尾；不能是第一条；连续多条视为一段。
 *
 * 分工：内核只把提醒标成“本轮 / 历史”两种内容（带 {@link TurnReminderMarker}），决定发送形态在这里：
 * - `claude_turn_scoped`：紧跟 user 内容的提醒编码为 Claude 专用的轮内系统消息（接入库 `Content.claudeSystemMessage`）；
 *   前一条不是 user 内容时（例如模型没有调用工具就停下、内核追加“未完成任务检查”），官方不允许放 system 消息，
 *   这条提醒按原来的尾巴形态作为 user 消息发出——之后的请求按同一规则在同一位置原样重发它，前缀仍然不变。
 * - `tail`：原来的尾巴模式，历史提醒全部不发，本轮提醒作为最后一条 user 消息。开关关闭时内核根本不产生标记，
 *   这里原样返回同一个数组，请求逐字节不变；其他 provider 和网关回退都走这条路径，历史提醒不会以任何形式泄漏过去。
 */
import type { MessageContent } from '../../shared/protocol';
import { isRecord } from './llmStreamEventProjection';
import type { EncodedProviderRequest } from './providerParameterAdaptation';

export const CLAUDE_TURN_SCOPED_SYSTEM_BETA = 'mid-conversation-system-clear-at-2026-08-21';

/** 内核附在提醒内容上的进程内标记；从不持久化，也不会出现在线上请求里。 */
export interface TurnReminderMarker {
  /** `current`：本请求的提醒；`history`：之前某次请求发过、紧挨在那次请求模型输出之前的提醒。 */
  placement: 'current' | 'history';
  /** 那次请求把当前 Turn 输入作为易失尾巴重新注入过（提醒原本跟在它后面，这个位置之后不再存在）。 */
  afterReinjectedInput?: true;
}

export type TurnReminderContent = MessageContent & { turnReminder: TurnReminderMarker };
export type ClaudeSystemMessageContent = MessageContent & { claudeSystemMessage: { clearAt: 'next_user_message' } };

export type TurnReminderLayout = 'claude_turn_scoped' | 'tail';

/** 一条提醒最终的发送形态：`system` 轮内系统消息；`user` 普通 user 消息（显示、计 token）；`omitted` 不发送。 */
export type TurnReminderDelivery = 'system' | 'user' | 'omitted';

export function turnReminderContent(text: string, marker: TurnReminderMarker): TurnReminderContent {
  return { role: 'user', parts: [{ text }], turnReminder: { ...marker } };
}

export function readTurnReminderMarker(content: MessageContent): TurnReminderMarker | undefined {
  const marker = (content as Partial<TurnReminderContent>).turnReminder;
  if (!isRecord(marker)) return undefined;
  if (marker.placement !== 'current' && marker.placement !== 'history') return undefined;
  return marker as unknown as TurnReminderMarker;
}

/**
 * 每条提醒的发送形态，按内容顺序计算；只看提醒前面最近一条非 system 内容的角色，
 * 因此只取决于那段稳定历史，同一历史每次得到同样的结果。
 */
export function turnReminderDeliveries(
  contents: readonly MessageContent[],
  layout: TurnReminderLayout
): Array<TurnReminderDelivery | undefined> {
  const deliveries: Array<TurnReminderDelivery | undefined> = [];
  let previousRole: MessageContent['role'] | undefined;
  for (const content of contents) {
    const marker = readTurnReminderMarker(content);
    if (!marker) {
      deliveries.push(undefined);
      previousRole = content.role;
      continue;
    }
    let delivery: TurnReminderDelivery;
    if (layout === 'tail') delivery = marker.placement === 'current' ? 'user' : 'omitted';
    else if (previousRole === 'user') delivery = 'system';
    else delivery = marker.placement === 'history' && marker.afterReinjectedInput ? 'omitted' : 'user';
    deliveries.push(delivery);
    if (delivery === 'user') previousRole = 'user';
  }
  return deliveries;
}

/** 去掉内核标记、按发送形态排好的内容；没有任何提醒标记时返回同一个数组（逐字节不变）。 */
export function layoutTurnReminderContents(
  contents: MessageContent[],
  layout: TurnReminderLayout
): MessageContent[] {
  if (!contents.some((content) => readTurnReminderMarker(content) !== undefined)) return contents;
  const deliveries = turnReminderDeliveries(contents, layout);
  const laidOut: MessageContent[] = [];
  contents.forEach((content, index) => {
    const delivery = deliveries[index];
    if (delivery === undefined) {
      laidOut.push(content);
      return;
    }
    if (delivery === 'omitted') return;
    const plain: MessageContent = { role: 'user', parts: content.parts };
    laidOut.push(delivery === 'system'
      ? { ...plain, claudeSystemMessage: { clearAt: 'next_user_message' } } as ClaudeSystemMessageContent
      : plain);
  });
  return laidOut;
}

export function isTurnScopedSystemMessage(message: unknown): boolean {
  return isRecord(message) && message.role === 'system' && message.clear_at === 'next_user_message';
}

function bodyHasTurnScopedSystemMessages(body: unknown): boolean {
  return isRecord(body) && Array.isArray(body.messages) && body.messages.some(isTurnScopedSystemMessage);
}

/**
 * 编码后的最后一步：本请求使用轮内系统消息模式（或请求体里确实有 clear_at 消息）时，把 beta 头合并进
 * `anthropic-beta`。已有值（用户自定义头、压缩或保留思考自动加的 beta）保留，逗号合并并去重。
 */
export function withClaudeTurnScopedSystemBeta(
  request: EncodedProviderRequest,
  active: boolean
): EncodedProviderRequest {
  if (!active && !bodyHasTurnScopedSystemMessages(request.body)) return request;
  const headers = withAnthropicBetaValue(request.headers, CLAUDE_TURN_SCOPED_SYSTEM_BETA);
  return headers === request.headers ? request : { ...request, headers };
}

export function withAnthropicBetaValue(headers: Record<string, string>, beta: string): Record<string, string> {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'anthropic-beta');
  const values = (existingKey ? headers[existingKey] : '').split(',').map((value) => value.trim()).filter(Boolean);
  const merged = [...new Set([...values, beta])].join(',');
  if (existingKey === 'anthropic-beta' && headers[existingKey] === merged) return headers;
  const next = { ...headers };
  if (existingKey) delete next[existingKey];
  next['anthropic-beta'] = merged;
  return next;
}

/**
 * 网关明确拒绝轮内系统消息的 400/422 文本。只在本请求确实用了轮内系统消息时才拿来判断（见 providerParameterAdaptation）。
 * - 官方原文（没有 beta 头时）：`messages.3.clear_at: Extra inputs are not permitted`；其他明确点名 clear_at 字段的拒绝。
 * - 官方轮内系统消息的其他校验原文都含 “turn-scoped system message”。
 * - 不支持 system 角色消息：旧版 Messages API 的 `Unexpected role "system". The Messages API accepts a top-level
 *   \`system\` parameter, not "system" as an input message role.`，以及 pydantic 风格
 *   `messages.3.role: Input should be 'user' or 'assistant'`。
 * - 位置不合法：提到 system 消息且说明必须/不能出现在某个位置的错误。
 */
const TURN_SCOPED_REJECTIONS: readonly RegExp[] = [
  /(?<![\w])clear_at['"`]?\s*:?\s*extra inputs are not permitted/i,
  /['"`]clear_at['"`][^\n]{0,80}(?:extra_forbidden|not permitted|unknown|unrecognized|unsupported|not allowed)/i,
  /(?:unknown|unrecognized|unsupported|unexpected)\s+(?:field|parameter|property|key|argument)s?[^\n]{0,40}clear_at/i,
  /turn-scoped system message/i,
  /unexpected role\W{1,3}system/i,
  /messages\.\d+\.role\W[^\n]{0,40}(?:input should be|must be one of|expected)[^\n]{0,40}user[^\n]{0,20}assistant/i,
  /(?:role\W{1,3}system\W|system role|system messages?\b)[^\n]{0,60}not (?:supported|allowed|permitted)/i,
  /system messages?\b[^\n]{0,120}(?:must|cannot|can't|can not|may not|may only|only allowed)[^\n]{0,120}(?:follow|after|before|precede|first|position|placed|immediately)/i
];

export function claudeTurnScopedRemindersRejected(errorText: string): boolean {
  return TURN_SCOPED_REJECTIONS.some((pattern) => pattern.test(errorText));
}

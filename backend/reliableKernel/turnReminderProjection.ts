import type { PlainJsonValue } from './plainJson';

/**
 * 每轮提醒（任务卡、未完成任务检查、运行状态卡）的唯一生成入口。
 *
 * 本请求的提醒和历史提醒都只从各自 ModelRequest 冻结的 recipe 经过这里生成：recipe 是不可变的
 * 内容寻址对象，同一个 recipe 永远得到逐字节相同的文本。Claude 轮内系统消息模式要求历史提醒原样重发
 * （https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 * “Re-send cleared messages verbatim”），所以这里的取值与拼接格式是持久契约：改动它会改变所有历史提醒的
 * 重发文本（一次性缓存失效、保留思考失效），必须同时更新固定格式的测试。
 */
export interface TurnReminderProjection {
  content: string;
  taskCardSha256?: string;
  unfinishedTaskCount: number;
  activeChildCount: number;
  runningProcessCount: number;
}

export function projectTurnReminder(recipe: PlainJsonValue | undefined): TurnReminderProjection | undefined {
  if (!isRecord(recipe) || recipe.kind !== 'reliable-agent-turn') return undefined;
  const task = recipe.turnTaskCardReminderEnabled === false
    ? undefined
    : isRecord(recipe.turnTaskCard) ? recipe.turnTaskCard : undefined;
  const runtime = isRecord(recipe.runtimeStatusCard) ? recipe.runtimeStatusCard : undefined;
  const completionCheck = isRecord(recipe.openTaskCompletionCheck)
    ? recipe.openTaskCompletionCheck
    : undefined;
  const reminderParts = [
    typeof task?.card === 'string' && task.card.trim() ? task.card.trim() : '',
    typeof completionCheck?.card === 'string' && completionCheck.card.trim()
      ? completionCheck.card.trim()
      : '',
    typeof runtime?.card === 'string' && runtime.card.trim() ? runtime.card.trim() : ''
  ].filter(Boolean);
  if (reminderParts.length === 0) return undefined;
  return {
    content: reminderParts.join('\n\n'),
    ...(typeof task?.cardSha256 === 'string' && task.cardSha256.trim()
      ? { taskCardSha256: task.cardSha256.trim() }
      : {}),
    unfinishedTaskCount: nonNegativeRecipeInteger(task?.counts, 'unfinished'),
    activeChildCount: nonNegativeRecipeInteger(runtime, 'activeChildCount'),
    runningProcessCount: nonNegativeRecipeInteger(runtime, 'runningProcessCount')
  };
}

/** 那次请求把当前 Turn 输入作为易失尾巴重新注入过的那条输入（冻结在 recipe 里的引用）。 */
export interface ReinjectedCurrentTurnInputReference {
  messageRevisionId: string;
  contentObjectId: string;
}

/** 那次请求把当前 Turn 输入作为易失尾巴重新注入过：返回那条输入；它的提醒原本跟在那条重新注入的输入后面。 */
export function recipeReinjectedCurrentTurnInput(
  recipe: PlainJsonValue | undefined
): ReinjectedCurrentTurnInputReference | undefined {
  const current = isRecord(recipe) && isRecord(recipe.currentTurnInput) ? recipe.currentTurnInput : undefined;
  if (current?.reinject !== true) return undefined;
  if (typeof current.messageRevisionId !== 'string' || !current.messageRevisionId
    || typeof current.contentObjectId !== 'string' || !current.contentObjectId) {
    throw new Error('ModelRequest recipe.currentTurnInput is missing its frozen input reference.');
  }
  return { messageRevisionId: current.messageRevisionId, contentObjectId: current.contentObjectId };
}

/**
 * 普通请求 recipe 记下的每轮提醒发送方式（`recipe.turnReminderDelivery`）：冻结这次请求时开关打开，提醒按 Claude
 * 轮内系统消息发出。之后的请求只为这样的请求原样重建提醒与重新注入的输入；没有这个字段的请求当时以尾巴方式发出，
 * 那份提醒只在它自己那次请求里出现过，中途打开开关也不会把它补回历史（前缀从打开那一刻起重新开始，缓存失效一次）。
 */
export const CLAUDE_TURN_SCOPED_REMINDER_DELIVERY = 'claude_turn_scoped' as const;

export function recipeSentClaudeTurnScopedReminders(recipe: PlainJsonValue | undefined): boolean {
  return isRecord(recipe) && recipe.turnReminderDelivery === CLAUDE_TURN_SCOPED_REMINDER_DELIVERY;
}

/**
 * 本轮冻结的设置要求把每轮提醒作为 Claude 轮内系统消息发送。开关只在 Claude 渠道打开时写进
 * AuthoritySnapshot.model，其他 provider 与关闭时都没有这个字段。
 */
export function claudeTurnScopedRemindersEnabled(authority: PlainJsonValue | undefined): boolean {
  const model = isRecord(authority) && isRecord(authority.model) ? authority.model : undefined;
  return model?.provider === 'claude' && model.claudeTurnScopedReminders === true;
}

/**
 * Claude 原生压缩（on-demand compaction）也按轮内系统消息模式发送历史：官方要求 “Send the conversation as it stands”，
 * 与普通请求用同样的 system、tools 与消息；普通请求发过的历史提醒和重新注入的输入少了，前缀就与普通请求不同，
 * 缓存命中不了，那些消息之后的思考块也不再属于同一段对话。
 * 只在压缩目标就是本轮对话所用的同一 Claude 渠道与模型时成立（开关只对那个渠道冻结）；换渠道或换模型的压缩前缀本来就不同，
 * 保持原样。从原始记录重建（immutable_provenance）的压缩不是任何普通请求的前缀，也保持原样。
 */
export function claudeTurnScopedCompaction(
  authority: PlainJsonValue | undefined,
  recipe: PlainJsonValue | undefined
): boolean {
  if (!claudeTurnScopedRemindersEnabled(authority) || !isRecord(authority)) return false;
  if (!isRecord(recipe) || recipe.kind !== 'reliable-context-compression'
    || recipe.compressionMethodKind !== 'provider_native' || recipe.sourceReplay !== undefined) {
    return false;
  }
  const model = isRecord(authority.model) ? authority.model : undefined;
  const compression = isRecord(authority.compression) ? authority.compression : undefined;
  const provider = compression && isRecord(compression.provider) ? compression.provider : undefined;
  return provider?.provider === 'claude'
    && typeof provider.providerConfigId === 'string'
    && provider.providerConfigId === model?.providerConfigId
    && typeof provider.modelId === 'string'
    && provider.modelId === model?.modelId;
}

function nonNegativeRecipeInteger(container: PlainJsonValue | undefined, key: string): number {
  const record = isRecord(container) ? container : undefined;
  const value = record?.[key];
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function isRecord(value: unknown): value is { [key: string]: PlainJsonValue } {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

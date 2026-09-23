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
 * 本轮冻结的设置要求把每轮提醒作为 Claude 轮内系统消息发送。开关只在 Claude 渠道打开时写进
 * AuthoritySnapshot.model，其他 provider 与关闭时都没有这个字段。
 */
export function claudeTurnScopedRemindersEnabled(authority: PlainJsonValue | undefined): boolean {
  const model = isRecord(authority) && isRecord(authority.model) ? authority.model : undefined;
  return model?.provider === 'claude' && model.claudeTurnScopedReminders === true;
}

function nonNegativeRecipeInteger(container: PlainJsonValue | undefined, key: string): number {
  const record = isRecord(container) ? container : undefined;
  const value = record?.[key];
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function isRecord(value: unknown): value is { [key: string]: PlainJsonValue } {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

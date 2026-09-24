import type { LlmGenerationConfigRecord } from './protocol';

/** A cold-start safety budget, not a claim about a model's measured reasoning-token usage.
 * Both request authority and encoder call this; retries cannot silently remove or grow the limit. */
export function resolveSummaryOutputBudget(targetTokens: number | undefined, config?: LlmGenerationConfigRecord): number {
  const target = Number.isFinite(targetTokens) && Number(targetTokens) > 0 ? Math.min(8000, Math.ceil(Number(targetTokens))) : 8000;
  const budget = config?.thinkingConfig?.thinkingBudget;
  const reasoning = Number.isSafeInteger(budget) && Number(budget) > 0 ? Number(budget) : 0;
  const explicit = config?.maxOutputTokens;
  if (explicit !== undefined && (!Number.isSafeInteger(explicit) || explicit <= 0)) {
    throw Object.assign(new Error('总结最大输出 Token 必须是正整数。'), { code: 'SUMMARY_OUTPUT_BUDGET_INVALID' });
  }
  const output = explicit ?? Math.min(16000, Math.max(8192, target * 2, reasoning + target + 1024));
  if (reasoning >= output) throw Object.assign(new Error(
    '总结思考预算必须小于最大输出 Token；请显式增加输出上限或降低思考预算。'
  ), { code: 'SUMMARY_OUTPUT_BUDGET_INVALID' });
  return output;
}

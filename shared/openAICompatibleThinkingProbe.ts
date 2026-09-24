/**
 * “测试这个模型”（OpenAI 兼容渠道的思考参数测试）前后端共用的常量与说明文字。
 * 测试本身见 backend/capabilities/openAICompatibleThinkingProbe.ts；结果存在 `models[].capabilitySnapshot`
 * （`source: 'verified_probe'`），设置界面用 shared/modelCapabilities.ts 的 openAICompatibleThinkingProbeEvidence 取出。
 */
import type { ModelCapabilitySnapshot } from './modelCapabilities';
import type { OpenAICompatibleThinkingFormat } from './protocol';

/** 一次测试最多发出的请求数：基线 1 次、三种写法各 1 次、关闭 1 次、四档强度各 1 次。 */
export const OPENAI_COMPATIBLE_THINKING_PROBE_MAX_REQUESTS = 9;

const PROBED_FORMAT_LABELS: Record<Exclude<OpenAICompatibleThinkingFormat, 'omit'>, string> = {
  deepseek: 'DeepSeek 写法（thinking.type）',
  enable_thinking: 'enable_thinking 写法',
  reasoning_effort: 'OpenAI 写法（只发 reasoning_effort）'
};

/** 例如“DeepSeek 写法（thinking.type）；可以关闭思考；接受 low / high / max”。 */
export function describeOpenAICompatibleThinkingProbe(snapshot: ModelCapabilitySnapshot): string {
  const reasoning = snapshot.reasoning;
  const format = reasoning.wireFormat;
  if (!format || format === 'omit' || reasoning.family === 'none') return '没有看到思考输出，发送时仍按自动识别';
  const levels = reasoning.levels.filter((level) => level !== 'none');
  const efforts = levels.length
    ? `接受 ${levels.join(' / ')}`
    : format === 'reasoning_effort' ? '没有接受的强度' : '不接受 reasoning_effort，只开关思考';
  return `${PROBED_FORMAT_LABELS[format]}；${reasoning.canDisable ? '可以关闭思考' : '关不掉思考'}；${efforts}`;
}

/** 测试时间，按本地时间写成“09-24 10:30”。 */
export function openAICompatibleThinkingProbeTime(verifiedAt: string | undefined): string {
  const date = verifiedAt ? new Date(verifiedAt) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 例如“测试结果（09-24 10:30）：DeepSeek 写法（thinking.type）；可以关闭思考；接受 low / high / max”。 */
export function openAICompatibleThinkingProbeSummary(snapshot: ModelCapabilitySnapshot): string {
  const time = openAICompatibleThinkingProbeTime(snapshot.verifiedAt);
  return `测试结果${time ? `（${time}）` : ''}：${describeOpenAICompatibleThinkingProbe(snapshot)}`;
}

/**
 * “测试这个模型”（OpenAI 兼容渠道的思考参数测试）前后端共用的常量。
 * 测试本身见 backend/capabilities/openAICompatibleThinkingProbe.ts。
 */

/** 一次测试最多发出的请求数：基线 1 次、三种写法各 1 次、关闭 1 次、四档强度各 1 次。 */
export const OPENAI_COMPATIBLE_THINKING_PROBE_MAX_REQUESTS = 9;

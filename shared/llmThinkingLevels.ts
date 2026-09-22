import type { LlmProviderKind, LlmThinkingLevel } from './protocol';

/** Editing values accepted by the existing provider adapters; remote models may restrict them. */
export const THINKING_LEVEL_OPTIONS: Record<LlmProviderKind, readonly { value: LlmThinkingLevel; label: string; description?: string }[]> = {
  gemini: [
    { value: 'minimal', label: '最低' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' }
  ],
  claude: [
    { value: 'none', label: '关闭', description: '关闭思考' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'xhigh', label: '极高' },
    { value: 'max', label: '最高' }
  ],
  'openai-compatible': [
    { value: 'none', label: '关闭', description: '关闭推理强度' },
    { value: 'minimal', label: '最低' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'xhigh', label: '极高' },
    { value: 'max', label: '最高' }
  ],
  'openai-responses': [
    { value: 'none', label: '关闭', description: '关闭推理强度' },
    { value: 'minimal', label: '最低' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'xhigh', label: '极高' },
    { value: 'max', label: '最高' }
  ],
  deepseek: [
    { value: 'none', label: '关闭', description: '关闭思考' },
    { value: 'high', label: '高', description: '启用思考' },
    { value: 'max', label: '最高', description: '最大思考强度' }
  ]
};

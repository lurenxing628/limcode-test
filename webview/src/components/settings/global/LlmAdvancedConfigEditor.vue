<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  DEFAULT_LLM_RETRY_DELAY_SECONDS,
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  MAX_LLM_RETRY_DELAY_SECONDS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  defaultLlmPromptCacheModeForProvider,
  defaultLlmPromptCacheTtlForProvider,
  isPromptCacheSupportedProvider,
  type LlmGenerationConfigRecord,
  type LlmOpenAIResponsesTransport,
  type LlmProviderConfigRecord,
  type LlmPromptCacheConfigRecord,
  type LlmPromptCacheMode,
  type LlmPromptCacheTtl,
  type LlmProviderHeadersRecord,
  type LlmRequestBodyRecord,
  type LlmToolCallFormat
} from '@shared/protocol';
import {
  isAstraModel,
  isOfficialOpenAIChannel,
  normalizeOpenAIResponsesNativeSettings,
  openAIResponsesNativeCapabilities
} from '@shared/openAIResponsesCapabilities';
import type { OpenAIResponsesNativeSettings } from '@shared/openAIResponsesNative';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';
import LlmHeadersSettings from './parameters/LlmHeadersSettings.vue';
import LlmParameterSettings from './parameters/LlmParameterSettings.vue';

const TOKEN_STEP = 1_000;

type AdvancedConfigPatch = Partial<Pick<
  LlmProviderConfigRecord,
  'toolCallFormat' | 'openaiResponsesTransport' | 'stream' | 'retryOnError' | 'retryMaxAttempts' | 'retryDelaySeconds' | 'enableMultimodalTools' | 'systemPromptPrefix'
>>;

const props = defineProps<{
  config: LlmProviderConfigRecord;
}>();

const systemPromptPrefixScroller = ref<HTMLTextAreaElement | null>(null);

const emit = defineEmits<{
  (event: 'update-field', patch: AdvancedConfigPatch): void;
  (event: 'update-context-window-tokens', value: number | undefined): void;
  (event: 'update-generation-config', value: LlmGenerationConfigRecord | undefined): void;
  (event: 'update-request-body', value: LlmRequestBodyRecord | undefined): void;
  (event: 'update-prompt-cache', value: LlmPromptCacheConfigRecord | undefined): void;
  (event: 'update-native-responses', value: OpenAIResponsesNativeSettings | undefined): void;
  (event: 'update-headers', value: LlmProviderHeadersRecord | undefined): void;
}>();

const toolCallFormatOptions: SettingsDropdownOption[] = [
  { value: 'function-call', label: 'Function Call' }
];
const openaiResponsesTransportOptions: SettingsDropdownOption[] = [
  {
    value: 'http',
    label: 'HTTP',
    description: '每次请求按当前本地上下文发送完整 input，使用普通 Responses HTTP/SSE。'
  },
  {
    value: 'websocket',
    label: 'WebSocket',
    description: '保持连接并用 previous_response_id 发送增量 input；断线或记录变更后自动全量重建。'
  }
];
const promptCacheSupported = computed(() => isPromptCacheSupportedProvider(props.config.provider));
const promptCache = computed<LlmPromptCacheConfigRecord>(() => props.config.promptCache ?? {
  enabled: true,
  mode: defaultLlmPromptCacheModeForProvider(props.config.provider),
  ttl: defaultLlmPromptCacheTtlForProvider(props.config.provider)
});
const promptCacheModeOptions: SettingsDropdownOption[] = [
  {
    value: 'key',
    label: '缓存 Key',
    description: '仅发送按渠道、LLM 和对话自动生成的 prompt_cache_key；兼容不支持显式断点的 LLM。'
  },
  {
    value: 'explicit',
    label: '显式断点',
    description: '发送 prompt_cache_options，并在聊天记录末尾写入 prompt_cache_breakpoint；需 LLM 支持。'
  }
];
const promptCacheDescription = computed(() => {
  if (props.config.provider === 'openai-responses') {
    return promptCache.value.mode === 'explicit'
      ? '显式断点模式会发送 prompt_cache_options，并在聊天记录末尾添加断点；部分 LLM 或兼容渠道不支持该参数。'
      : '缓存 Key 模式会为同一渠道、LLM 和对话自动生成稳定的 prompt_cache_key；不发送显式断点或缓存时间参数。';
  }
  if (props.config.provider === 'claude') {
    return 'Claude 会在系统提示词、工具定义结束和聊天记录末尾写入缓存断点，并支持缓存时间档位。';
  }
  return '当前渠道暂未接入 Prompt Cache。';
});
const promptCacheTtlOptions = computed<SettingsDropdownOption[]>(() => {
  if (props.config.provider === 'openai-responses') {
    return [{ value: '30m', label: '30 分钟', description: 'OpenAI Responses 目前仅支持 30m。' }];
  }
  if (props.config.provider === 'claude') {
    return [
      { value: '1h', label: '1 小时', description: 'Anthropic 最长档位，写入成本更高但命中窗口更长。' },
      { value: '5m', label: '5 分钟', description: 'Anthropic 默认档位。' }
    ];
  }
  return [{ value: defaultLlmPromptCacheTtlForProvider(props.config.provider), label: '最长档位', description: '当前渠道暂未接入 Prompt Cache 断点。' }];
});

function numericInputValue(event: Event): number | undefined {
  const value = (event.target as HTMLInputElement).value.trim();
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function alignTokenCountToK(value: number): number {
  return Math.max(TOKEN_STEP, Math.round(value / TOKEN_STEP) * TOKEN_STEP);
}

function normalizeRetryMaxAttempts(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LLM_RETRY_MAX_ATTEMPTS;
  const attempts = Math.floor(number);
  return attempts < -1 ? -1 : attempts;
}

function normalizeRetryDelaySeconds(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LLM_RETRY_DELAY_SECONDS;
  const seconds = Math.floor(number);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_LLM_RETRY_DELAY_SECONDS);
}

function updateContextWindowTokens(event: Event): void {
  const value = numericInputValue(event);
  emit('update-context-window-tokens', value === undefined ? undefined : alignTokenCountToK(value));
}

function updateRetryMaxAttempts(event: Event): void {
  emit('update-field', { retryMaxAttempts: normalizeRetryMaxAttempts(numericInputValue(event)) });
}

function updateRetryDelaySeconds(event: Event): void {
  emit('update-field', { retryDelaySeconds: normalizeRetryDelaySeconds(numericInputValue(event)) });
}

function updateSystemPromptPrefix(event: Event): void {
  emit('update-field', { systemPromptPrefix: (event.target as HTMLTextAreaElement).value });
}

function updateToolCallFormat(value: string): void {
  emit('update-field', { toolCallFormat: value as LlmToolCallFormat });
}

function updateOpenAIResponsesTransport(value: string): void {
  emit('update-field', { openaiResponsesTransport: (value === 'websocket' ? 'websocket' : 'http') as LlmOpenAIResponsesTransport });
}

function updatePromptCacheEnabled(enabled: boolean): void {
  emit('update-prompt-cache', {
    ...promptCache.value,
    enabled,
    mode: normalizePromptCacheMode(promptCache.value.mode),
    ttl: normalizePromptCacheTtl(promptCache.value.ttl)
  });
}

function updatePromptCacheMode(value: string): void {
  emit('update-prompt-cache', {
    ...promptCache.value,
    mode: normalizePromptCacheMode(value),
    ttl: normalizePromptCacheTtl(promptCache.value.ttl)
  });
}

function updatePromptCacheTtl(value: string): void {
  emit('update-prompt-cache', {
    ...promptCache.value,
    ttl: normalizePromptCacheTtl(value)
  });
}

function normalizePromptCacheMode(value: string | undefined): LlmPromptCacheMode {
  if (props.config.provider === 'openai-responses' && value === 'explicit') return 'explicit';
  return defaultLlmPromptCacheModeForProvider(props.config.provider);
}

function normalizePromptCacheTtl(value: string | undefined): LlmPromptCacheTtl {
  if (props.config.provider === 'openai-responses') return '30m';
  if (props.config.provider === 'claude') return value === '5m' || value === '1h' ? value : '1h';
  return defaultLlmPromptCacheTtlForProvider(props.config.provider);
}

const nativeModelSupported = computed(() => props.config.provider === 'openai-responses' && isAstraModel(props.config.model));
const nativeOfficialChannel = computed(() => isOfficialOpenAIChannel(props.config.baseUrl));
const nativeSettings = computed(() => normalizeOpenAIResponsesNativeSettings(props.config.nativeResponses));
/** 原生能力总闸：精确 Astra 模型，且官方渠道或显式确认中继支持；显式禁用永远关闭。 */
const nativeGateAvailable = computed(() => {
  if (!nativeModelSupported.value) return false;
  const enabled = nativeSettings.value?.enabled;
  if (enabled === false) return false;
  return enabled === true || nativeOfficialChannel.value;
});
const nativeCapabilities = computed(() => openAIResponsesNativeCapabilities({
  provider: props.config.provider,
  model: props.config.model,
  baseUrl: props.config.baseUrl,
  transport: props.config.openaiResponsesTransport,
  nativeResponses: props.config.nativeResponses
}));
const nativeWebsocketTransport = computed(() => (props.config.openaiResponsesTransport ?? 'http') === 'websocket');
const nativeEnabledState = computed(() => {
  const enabled = nativeSettings.value?.enabled;
  return enabled === true ? 'enabled' : enabled === false ? 'disabled' : 'default';
});
const nativeEnabledStateOptions: SettingsDropdownOption[] = [
  {
    value: 'default',
    label: '按渠道默认',
    description: '官方 OpenAI 渠道视为支持 Astra 原生能力；第三方中继默认不使用。'
  },
  {
    value: 'enabled',
    label: '确认支持并启用',
    description: '显式确认该渠道或中继支持 Astra 原生 Responses 能力（异步工具、转向、动态推理、多路复用）。'
  },
  {
    value: 'disabled',
    label: '禁用原生能力',
    description: '即使是官方渠道也不使用原生能力，退回普通 Responses 行为。'
  }
];
const nativeCapabilityStateText = computed(() => {
  if (!nativeModelSupported.value) return '当前 LLM 不支持';
  if (!nativeGateAvailable.value) return '未启用';
  return '已启用';
});
const nativeCapabilityRows = computed(() => [
  { label: '原生异步工具', value: nativeCapabilities.value.asyncTools ? '可用' : '不可用' },
  { label: '回合内转向', value: nativeCapabilities.value.steering ? '可用' : '不可用' },
  { label: '动态推理更新', value: nativeCapabilities.value.reasoningUpdates ? '可用' : '不可用' },
  { label: 'WebSocket 多路复用', value: nativeCapabilities.value.multiplexing ? '可用' : '不可用' },
  { label: '显式缓存', value: nativeCapabilities.value.explicitCaching ? '可用' : '不可用' }
]);
const nativeGateHint = computed(() => {
  if (props.config.provider !== 'openai-responses') return '';
  if (!nativeModelSupported.value) {
    return '原生能力只对精确的 gpt-6-astra（含日期版本）开放，不会从其它 gpt-* 名称推断；当前 LLM 使用普通 Responses 行为。';
  }
  if (nativeSettings.value?.enabled === false) return '原生能力已显式禁用；当前 LLM 使用普通 Responses 行为。';
  if (!nativeOfficialChannel.value && nativeSettings.value?.enabled !== true) {
    return '第三方中继默认不使用原生能力；确认该中继支持后，将上方设置改为「确认支持并启用」。';
  }
  return '原生能力只影响 Astra 原生请求；进行中的请求以发起时冻结的能力为准，修改设置不会改变已发出的请求。';
});

function emitNativeResponses(next: OpenAIResponsesNativeSettings): void {
  emit('update-native-responses', normalizeOpenAIResponsesNativeSettings(next));
}

function updateNativeEnabledState(value: string): void {
  const current = nativeSettings.value ?? {};
  if (value === 'enabled') {
    emitNativeResponses({ ...current, enabled: true });
    return;
  }
  if (value === 'disabled') {
    emitNativeResponses({ ...current, enabled: false });
    return;
  }
  const rest = { ...current };
  delete rest.enabled;
  emitNativeResponses(rest);
}

function updateNativeFlag(key: 'asyncTools' | 'steering' | 'reasoningUpdates' | 'multiplexing', value: boolean): void {
  emitNativeResponses({ ...(nativeSettings.value ?? {}), [key]: value });
}
</script>

<template>
  <div class="global-settings-grid advanced-config-editor">
    <label class="global-settings-field">
      <span>工具调用格式</span>
      <SettingsDropdown
        :model-value="config.toolCallFormat"
        :options="toolCallFormatOptions"
        title="选择工具调用格式"
        @update:model-value="updateToolCallFormat"
      />
    </label>

    <label v-if="config.provider === 'openai-responses'" class="global-settings-field openai-responses-transport-field">
      <span>连接模式</span>
      <SettingsDropdown
        :model-value="config.openaiResponsesTransport ?? 'http'"
        :options="openaiResponsesTransportOptions"
        title="选择 OpenAI Responses 连接模式"
        @update:model-value="updateOpenAIResponsesTransport"
      />
      <span class="stream-checkbox-text">WebSocket 模式不会在服务端保存对话；断线或重新加载后，会使用本地聊天记录恢复上下文。</span>
    </label>

    <label class="global-settings-field context-window-field">
      <span>上下文窗口 Token 数</span>
      <input
        class="token-number-input"
        :value="config.contextWindowTokens ?? ''"
        type="number"
        min="1000"
        :step="TOKEN_STEP"
        placeholder="例如 200000"
        @change="updateContextWindowTokens"
      />
    </label>

    <div class="global-settings-field stream-field">
      <span>流式生成</span>
      <div class="stream-checkbox-row">
        <LcCheckbox
          :model-value="config.stream !== false"
          size="sm"
          aria-label="启用流式生成"
          @update:model-value="emit('update-field', { stream: $event })"
        >
          <span class="stream-checkbox-enable">启用</span>
        </LcCheckbox>
      </div>
      <span class="stream-checkbox-text">启用流式生成。普通回复和上下文压缩会复用此配置。</span>
    </div>

    <div class="global-settings-field stream-field">
      <span>多模态工具</span>
      <div class="stream-checkbox-row">
        <LcCheckbox
          :model-value="config.enableMultimodalTools !== false"
          size="sm"
          aria-label="启用多模态工具"
          @update:model-value="emit('update-field', { enableMultimodalTools: $event })"
        >
          <span class="stream-checkbox-enable">启用</span>
        </LcCheckbox>
      </div>
      <span class="stream-checkbox-text">启用后 read 可返回图片、PDF 等附件内容；关闭后 read 只读取文本。</span>
    </div>

    <div class="global-settings-field stream-field prompt-cache-field">
      <span>提示词缓存</span>
      <div class="stream-checkbox-row">
        <LcCheckbox
          :model-value="promptCache.enabled && promptCacheSupported"
          :disabled="!promptCacheSupported"
          size="sm"
          aria-label="启用提示词缓存"
          @update:model-value="updatePromptCacheEnabled"
        >
          <span class="stream-checkbox-enable">启用提示词缓存</span>
        </LcCheckbox>
      </div>
      <span class="stream-checkbox-text">{{ promptCacheDescription }}</span>
    </div>

    <label v-if="config.provider === 'openai-responses'" class="global-settings-field prompt-cache-mode-field">
      <span>缓存模式</span>
      <SettingsDropdown
        :model-value="promptCache.mode"
        :options="promptCacheModeOptions"
        :disabled="!promptCacheSupported || !promptCache.enabled"
        title="选择 OpenAI Responses 提示词缓存模式"
        @update:model-value="updatePromptCacheMode"
      />
    </label>

    <label v-if="config.provider === 'claude'" class="global-settings-field prompt-cache-ttl-field">
      <span>缓存时间</span>
      <SettingsDropdown
        :model-value="promptCache.ttl"
        :options="promptCacheTtlOptions"
        :disabled="!promptCacheSupported || !promptCache.enabled"
        title="选择提示词缓存时间"
        @update:model-value="updatePromptCacheTtl"
      />
    </label>

    <template v-if="config.provider === 'openai-responses'">
      <div class="global-settings-field global-settings-field-wide native-capabilities-field">
        <span class="native-capabilities-heading">
          <span>Astra 原生能力</span>
          <HoverTooltipPanel
            panel-title="原生能力状态"
            :rows="nativeCapabilityRows"
            :delay-ms="180"
          >
            <button type="button" class="native-capability-badge" :class="{ 'is-active': nativeGateAvailable }">
              {{ nativeCapabilityStateText }}
            </button>
          </HoverTooltipPanel>
        </span>
        <span class="stream-checkbox-text">{{ nativeGateHint }}</span>
      </div>

      <label class="global-settings-field native-enabled-state-field">
        <span>原生能力支持</span>
        <SettingsDropdown
          :model-value="nativeEnabledState"
          :options="nativeEnabledStateOptions"
          :disabled="!nativeModelSupported"
          title="选择 Astra 原生能力支持方式"
          @update:model-value="updateNativeEnabledState"
        />
        <span class="stream-checkbox-text">第三方中继选择「确认支持并启用」，即确认该中继支持 Astra 原生能力。</span>
      </label>

      <div class="global-settings-field stream-field">
        <span>原生异步工具</span>
        <div class="stream-checkbox-row">
          <LcCheckbox
            :model-value="nativeCapabilities.asyncTools"
            :disabled="!nativeGateAvailable"
            size="sm"
            aria-label="启用原生异步工具"
            @update:model-value="updateNativeFlag('asyncTools', $event)"
          >
            <span class="stream-checkbox-enable">启用</span>
          </LcCheckbox>
        </div>
        <span class="stream-checkbox-text">在工具策略中单独标记「原生异步」的工具可以异步执行，结果稍后按原始调用 ID 回传；不改变执行审批、文件审批与调度方式。</span>
      </div>

      <div class="global-settings-field stream-field">
        <span>回合内转向</span>
        <div class="stream-checkbox-row">
          <LcCheckbox
            :model-value="nativeCapabilities.steering"
            :disabled="!nativeGateAvailable || !nativeWebsocketTransport"
            size="sm"
            aria-label="启用回合内转向"
            @update:model-value="updateNativeFlag('steering', $event)"
          >
            <span class="stream-checkbox-enable">启用</span>
          </LcCheckbox>
        </div>
        <span class="stream-checkbox-text">回复进行中可把新消息立即注入当前原生请求，被接受的输入会产生后续响应；需要 WebSocket 连接模式。转向回执中的「已发送 / 已接受」不代表内容已生效。</span>
      </div>

      <div class="global-settings-field stream-field">
        <span>动态推理更新</span>
        <div class="stream-checkbox-row">
          <LcCheckbox
            :model-value="nativeCapabilities.reasoningUpdates"
            :disabled="!nativeGateAvailable"
            size="sm"
            aria-label="启用动态推理更新"
            @update:model-value="updateNativeFlag('reasoningUpdates', $event)"
          >
            <span class="stream-checkbox-enable">启用</span>
          </LcCheckbox>
        </div>
        <span class="stream-checkbox-text">允许在两个响应之间调整推理档位。Limcode 的本地上下文压缩与动态推理兼容：压缩请求不携带推理更新，压缩完成后自动恢复当前档位（缓存会重置并可观察）；与服务端自动压缩不兼容的机制 Limcode 不使用。</span>
      </div>

      <div class="global-settings-field stream-field">
        <span>WebSocket 多路复用</span>
        <div class="stream-checkbox-row">
          <LcCheckbox
            :model-value="nativeCapabilities.multiplexing"
            :disabled="!nativeGateAvailable || !nativeWebsocketTransport"
            size="sm"
            aria-label="启用 WebSocket 多路复用"
            @update:model-value="updateNativeFlag('multiplexing', $event)"
          >
            <span class="stream-checkbox-enable">启用</span>
          </LcCheckbox>
        </div>
        <span class="stream-checkbox-text">多个对话以命名通道复用同一 WebSocket 物理连接；需要 WebSocket 连接模式。物理连接断开会使所有通道的缓存失效。</span>
      </div>

      <div v-if="nativeCapabilities.explicitCaching" class="global-settings-field stream-field native-explicit-cache-field">
        <span>显式缓存</span>
        <span class="stream-checkbox-text">Astra 原生连接保留显式缓存参数：prompt_cache_options（30 分钟 TTL）与内容缓存断点不会被剥离；本地上下文压缩后缓存重置，并随后续请求重建。在上方「提示词缓存」中选择缓存模式。</span>
      </div>
    </template>

    <div class="global-settings-field stream-field retry-field">
      <span>报错自动重试</span>
      <div class="stream-checkbox-row">
        <LcCheckbox
          :model-value="config.retryOnError ?? DEFAULT_LLM_RETRY_ON_ERROR"
          size="sm"
          aria-label="启用报错自动重试"
          @update:model-value="emit('update-field', { retryOnError: $event })"
        >
          <span class="stream-checkbox-enable">启用</span>
        </LcCheckbox>
      </div>
      <span class="stream-checkbox-text">请求报错时自动重试。重试次数不包含原始请求；设置为 -1 表示无限重试。</span>
    </div>

    <label class="global-settings-field retry-attempts-field">
      <span>最大重试次数</span>
      <input
        class="token-number-input"
        :value="config.retryMaxAttempts ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS"
        type="number"
        min="-1"
        step="1"
        placeholder="4"
        @change="updateRetryMaxAttempts"
      />
    </label>

    <label class="global-settings-field">
      <span>重试间隔（秒）</span>
      <span class="global-settings-field-hint">每次重试前固定等待的秒数，用来避开 TPM 限流；填 0 表示沿用自动退避（0.5 秒起指数递增，最长 8 秒）。</span>
      <input
        class="token-number-input"
        :value="config.retryDelaySeconds ?? DEFAULT_LLM_RETRY_DELAY_SECONDS"
        type="number"
        min="0"
        :max="MAX_LLM_RETRY_DELAY_SECONDS"
        step="1"
        placeholder="0"
        @change="updateRetryDelaySeconds"
      />
    </label>

    <label class="global-settings-field global-settings-field-wide system-prompt-prefix-field">
      <span>前置系统提示词</span>
      <span class="global-settings-field-hint">不添加标题；非空内容会放在最终系统提示词的最前面，并与后面的内容空一行。</span>
      <div class="system-prompt-prefix-shell">
        <textarea
          ref="systemPromptPrefixScroller"
          :value="config.systemPromptPrefix"
          rows="5"
          aria-label="前置系统提示词"
          placeholder="默认为空；填写仅供当前渠道或 LLM 使用的额外要求…"
          spellcheck="false"
          @input="updateSystemPromptPrefix"
        ></textarea>
        <AdvancedScrollbar :scroller="systemPromptPrefixScroller" variant="minimal" />
      </div>
    </label>

    <LlmParameterSettings
      class="global-settings-field-wide"
      :config="config"
      @update-generation-config="emit('update-generation-config', $event)"
      @update-request-body="emit('update-request-body', $event)"
    />

    <LlmHeadersSettings
      class="global-settings-field-wide"
      :model-value="config.headers ?? {}"
      @update:model-value="emit('update-headers', $event)"
    />
  </div>
</template>

<style scoped>
.advanced-config-editor {
  margin: 0;
}

.stream-field {
  justify-content: start;
}

.system-prompt-prefix-shell {
  position: relative;
  min-height: 112px;
}

.system-prompt-prefix-shell textarea {
  width: 100%;
  min-height: 112px;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: 12px/1.5 var(--vscode-editor-font-family, monospace);
  outline: none;
  scrollbar-width: none;
}

.system-prompt-prefix-shell textarea::-webkit-scrollbar {
  display: none;
}

.system-prompt-prefix-shell textarea:focus {
  border-color: var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-input-background) 94%, var(--vscode-foreground) 6%);
}

.stream-checkbox-row {
  min-height: 20px;
  display: flex;
  align-items: center;
}

.stream-checkbox-row :deep(.lc-checkbox-control) {
  align-items: center;
}

.stream-checkbox-row :deep(.lc-checkbox-box) {
  flex: 0 0 auto;
}

.stream-checkbox-enable {
  color: var(--vscode-foreground);
  font-size: var(--font-size-xs);
  line-height: 1.2;
}

.stream-checkbox-text {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.native-capabilities-heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.native-capability-badge {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: 1.6;
  cursor: default;
}

.native-capability-badge.is-active {
  color: var(--vscode-foreground);
}

.token-number-input[type='number'] {
  appearance: textfield;
  -moz-appearance: textfield;
}

.token-number-input[type='number']::-webkit-outer-spin-button,
.token-number-input[type='number']::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}
</style>

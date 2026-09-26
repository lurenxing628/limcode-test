<script setup lang="ts">
import { ref } from 'vue';
import type { WorkEnvironmentRecord } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';

const props = defineProps<{
  environment: WorkEnvironmentRecord;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  update: [patch: Partial<WorkEnvironmentRecord>];
}>();

const descriptionScroller = ref<HTMLElement | null>(null);
const sshAuthMethodByEnvironmentId = ref<Record<string, 'identityFile' | 'password'>>({});

const osOptions: SettingsDropdownOption[] = [
  { value: '', label: '未设置' },
  { value: 'linux', label: 'linux' },
  { value: 'windows', label: 'windows' },
  { value: 'macos', label: 'macos' },
  { value: 'unknown', label: 'unknown' }
];
const sshAuthMethodOptions: SettingsDropdownOption[] = [
  { value: 'identityFile', label: 'IdentityFile', description: '使用 SSH 密钥文件登录' },
  { value: 'password', label: 'Password', description: '使用密码登录' }
];

function updateRemoteField(field: keyof WorkEnvironmentRecord, value: string | number | boolean | undefined): void {
  if (props.readonly) return;
  const credentialPatch = field === 'identityFile' && typeof value === 'string' && value.trim()
    ? { password: undefined }
    : field === 'password' && typeof value === 'string' && value
      ? { identityFile: undefined }
      : {};
  if (field === 'identityFile' && typeof value === 'string' && value.trim()) sshAuthMethodByEnvironmentId.value[props.environment.id] = 'identityFile';
  if (field === 'password' && typeof value === 'string' && value) sshAuthMethodByEnvironmentId.value[props.environment.id] = 'password';
  emit('update', { [field]: value, ...credentialPatch });
}

function sshAuthMethod(environment: WorkEnvironmentRecord | undefined): string {
  if (environment?.id && sshAuthMethodByEnvironmentId.value[environment.id]) return sshAuthMethodByEnvironmentId.value[environment.id];
  if (environment?.identityFile?.trim()) return 'identityFile';
  if (environment?.password) return 'password';
  return 'identityFile';
}

function updateSshAuthMethod(value: string): void {
  if (props.readonly) return;
  sshAuthMethodByEnvironmentId.value[props.environment.id] = value === 'password' ? 'password' : 'identityFile';
  if (value === 'password') updateRemoteField('identityFile', undefined);
  else updateRemoteField('password', undefined);
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

function editableText(event: Event): string {
  return (event.currentTarget as HTMLElement | null)?.textContent ?? '';
}

function inputOptionalNumber(event: Event): number | undefined {
  const raw = (event.target as HTMLInputElement).value.trim();
  return raw ? normalizePositiveInteger(raw) : undefined;
}

function normalizePositiveInteger(value: string): number | undefined {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
</script>

<template>
  <div class="work-env-form-grid">
    <label class="global-settings-field">
      <span>名称</span>
      <input :value="environment.name ?? ''" :readonly="readonly" type="text" placeholder="必填，便于你和 LLM 识别此环境" @change="updateRemoteField('name', inputValue($event))" />
    </label>
    <label class="global-settings-field">
      <span>主机地址</span>
      <input :value="environment.host ?? environment.name" :readonly="readonly" type="text" @change="updateRemoteField('host', inputValue($event))" />
    </label>
    <label class="global-settings-field">
      <span>用户名</span>
      <input :value="environment.user ?? ''" :readonly="readonly" type="text" placeholder="必填，例如：root" @change="updateRemoteField('user', inputValue($event))" />
    </label>
    <label class="global-settings-field">
      <span>端口（可选）</span>
      <input :value="environment.port ?? ''" :readonly="readonly" type="number" placeholder="默认 22" @change="updateRemoteField('port', inputOptionalNumber($event))" />
    </label>
    <label class="global-settings-field global-settings-field-wide">
      <span>SSH 登录方式</span>
      <SettingsDropdown
        :model-value="sshAuthMethod(environment)"
        :options="sshAuthMethodOptions"
        title="选择 SSH 登录方式"
        :disabled="readonly"
        @update:model-value="updateSshAuthMethod"
      />
    </label>
    <label v-if="sshAuthMethod(environment) === 'identityFile'" class="global-settings-field global-settings-field-wide">
      <span>SSH 私钥文件</span>
      <input :value="environment.identityFile ?? ''" :readonly="readonly" type="text" placeholder="必填，例如：C:\Users\you\.ssh\id_rsa" @change="updateRemoteField('identityFile', inputValue($event))" />
      <small>如果同时配置了私钥文件和密码，将优先使用私钥文件。</small>
    </label>
    <label v-else class="global-settings-field global-settings-field-wide">
      <span>密码</span>
      <input :value="environment.password ?? ''" :readonly="readonly" type="password" autocomplete="off" placeholder="必填，输入 SSH 登录密码" @change="updateRemoteField('password', inputValue($event))" />
    </label>
    <label class="global-settings-field">
      <span>工作目录（可选）</span>
      <input :value="environment.workdir ?? ''" :readonly="readonly" type="text" placeholder="例如：/root 或 ~/project" @change="updateRemoteField('workdir', inputValue($event))" />
    </label>
    <label class="global-settings-field">
      <span>操作系统（可选）</span>
      <SettingsDropdown
        :model-value="environment.os ?? ''"
        :options="osOptions"
        title="选择系统"
        :disabled="readonly"
        @update:model-value="updateRemoteField('os', $event)"
      />
    </label>
    <label class="global-settings-field global-settings-field-wide">
      <span>说明（可选）</span>
      <div class="work-env-description-shell">
        <div
          :key="environment.id"
          ref="descriptionScroller"
          class="work-env-description-editor"
          :class="{ 'is-readonly': readonly }"
          :contenteditable="readonly ? 'false' : 'plaintext-only'"
          role="textbox"
          aria-multiline="true"
          data-placeholder="描述这个服务器环境的用途、权限边界或注意事项"
          @blur="updateRemoteField('description', editableText($event))"
        >{{ environment.description ?? '' }}</div>
        <AdvancedScrollbar :scroller="descriptionScroller" :refresh-key="environment.id" variant="minimal" />
      </div>
    </label>
  </div>
</template>

<style scoped>
.work-env-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.work-env-form-grid .global-settings-field small {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  opacity: 0.82;
}

.work-env-form-grid :deep(input[type='number']) {
  appearance: textfield;
  -moz-appearance: textfield;
}

.work-env-form-grid :deep(input[type='number']::-webkit-outer-spin-button),
.work-env-form-grid :deep(input[type='number']::-webkit-inner-spin-button) {
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
}

.work-env-description-shell {
  position: relative;
  overflow: hidden;
}

.work-env-description-editor {
  width: 100%;
  height: 86px;
  overflow-y: auto;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2) calc(var(--space-2) + 10px) var(--space-2) var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: none;
}

.work-env-description-editor::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.work-env-description-editor:empty::before {
  content: attr(data-placeholder);
  color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
  pointer-events: none;
}

.work-env-description-editor:focus {
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
}

.work-env-description-editor.is-readonly {
  color: var(--vscode-descriptionForeground);
  cursor: default;
  opacity: 0.82;
}

@media (max-width: 820px) {
  .work-env-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>

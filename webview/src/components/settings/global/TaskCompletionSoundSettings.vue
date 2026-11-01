<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { MAX_TASK_COMPLETION_AUDIO_BYTES } from '@shared/taskCompletionSound';
import { playTaskCompletionSound, stopTaskCompletionSound } from '@webview/platform/taskCompletionSound';

const settings = useGlobalSettingsStore();
const fileInput = ref<HTMLInputElement>();
const error = ref('');
const importing = ref(false);
let reader: FileReader | undefined;

async function preview(): Promise<void> {
  error.value = '';
  try { await playTaskCompletionSound(settings.taskCompletionSound); }
  catch { error.value = '无法播放提示音，请换一个 MP3 或 WAV 文件。'; }
}

function importAudio(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  error.value = '';
  if (!/\.(mp3|wav)$/i.test(file.name) || file.size > MAX_TASK_COMPLETION_AUDIO_BYTES || file.size === 0) {
    error.value = '请选择不超过 2 MB 的 MP3 或 WAV 短音频。';
    return;
  }
  importing.value = true;
  reader = new FileReader();
  reader.onload = () => {
    settings.taskCompletionSound.audioDataUrl = String(reader!.result);
    settings.taskCompletionSound.audioName = file.name;
    importing.value = false;
  };
  reader.onerror = () => { error.value = '读取音频失败，请重新选择。'; importing.value = false; };
  reader.readAsDataURL(new Blob([file], { type: /\.mp3$/i.test(file.name) ? 'audio/mpeg' : 'audio/wav' }));
}

function restoreDefault(): void {
  stopTaskCompletionSound();
  settings.taskCompletionSound.audioDataUrl = '';
  settings.taskCompletionSound.audioName = '';
  error.value = '';
}

onBeforeUnmount(() => { reader?.abort(); stopTaskCompletionSound(); });
</script>

<template>
  <div class="global-settings-field" aria-label="任务完成提示音设置">
    <LcCheckbox v-model="settings.taskCompletionSound.enabled" size="sm" aria-label="任务完成提示音">
      <span class="global-settings-checkbox-label">任务完成提示音</span>
    </LcCheckbox>
    <span class="global-settings-field-hint">默认关闭。主对话成功完成时播放一次；工具执行、子 Agent、失败或停止不播放。对话标签页在后台时也可播放。</span>
    <span class="global-settings-field-hint">当前音效：{{ settings.taskCompletionSound.audioName || '内置提示音' }}。可导入几秒的语音或音效（MP3 / WAV，不超过 2 MB）。</span>
    <label class="sound-volume">
      <span>音量（0–100%）</span>
      <input v-model.number="settings.taskCompletionSound.volume" type="number" min="0" max="100" step="1" aria-label="提示音音量" />
    </label>
    <input ref="fileInput" type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" hidden aria-label="选择提示音文件" @change="importAudio" />
    <div class="global-settings-actions">
      <button type="button" class="secondary" :disabled="importing" @click="fileInput?.click()">导入音频…</button>
      <button type="button" class="secondary" :disabled="importing" @click="preview">试听</button>
      <button type="button" class="secondary" :disabled="importing || !settings.taskCompletionSound.audioDataUrl" @click="restoreDefault">恢复内置音效</button>
    </div>
    <span v-if="error" role="alert" class="sound-error">{{ error }}</span>
  </div>
</template>

<style scoped>
.sound-volume { display: flex; align-items: center; gap: 12px; }
.sound-volume input { width: 80px; }
.sound-error { color: var(--vscode-errorForeground); }
</style>

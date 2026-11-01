<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { BridgeMessageType, type LanMobileAccessStatePayload } from '@shared/protocol';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { bridge } from '@webview/transport';

// Not a saved setting: the extension owns the switch (it listens on the network) and reports its state.
const state = ref<LanMobileAccessStatePayload>();
const pending = ref(false);
const stop = bridge.on(BridgeMessageType.LanMobileAccessState, (message) => {
  if (!message.payload) return;
  state.value = message.payload;
  pending.value = false;
});
onBeforeUnmount(stop);
bridge.request(BridgeMessageType.LanMobileAccessRequest, {});

function toggle(enabled: boolean): void {
  pending.value = true;
  bridge.request(BridgeMessageType.LanMobileAccessRequest, { enabled });
}
</script>

<template>
  <div class="global-settings-field">
    <span>远程访问</span>
    <LcCheckbox
      :model-value="state?.enabled ?? false"
      :disabled="!state || pending"
      size="sm"
      aria-label="开启局域网远程访问"
      @update:model-value="toggle($event)"
    >
      <span class="global-settings-checkbox-label">允许同一局域网的手机或电脑通过浏览器访问</span>
    </LcCheckbox>
    <span v-if="state?.enabled" class="global-settings-field-hint">
      在手机浏览器打开 <code>{{ state.urls.join('  ') }}</code>；右下角状态栏显示“远程访问”，点击可复制地址或关闭。
    </span>
    <span v-if="state?.error" class="global-settings-field-hint" role="alert">开启失败：{{ state.error }}</span>
    <span class="global-settings-field-hint">默认关闭，不需要密码：同一网络内的设备都能查看和操作这个窗口的对话，不用时请关闭。只对当前窗口生效，重载或重开这个工作区后仍保持开启。</span>
  </div>
</template>

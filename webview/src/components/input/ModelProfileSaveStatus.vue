<script setup lang="ts">
import { computed } from 'vue';
import type { ConfigScopeKind } from '@shared/protocol';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
const props = defineProps<{ scopeKind: ConfigScopeKind; scopeId?: string; sendError?: string }>();
const store = useModelProfileStore();
const pending = computed(() => store.pendingFor(props.scopeKind, props.scopeId));
const detached = computed(() => store.detachedFor(props.scopeKind, props.scopeId));
const saved = computed(() => store.confirmedFor(props.scopeKind, props.scopeId));
const scopeError = computed(() => store.errorFor(props.scopeKind, props.scopeId));
const reading = computed(() => store.readingFor(props.scopeKind, props.scopeId));
const effective = computed(() => saved.value?.effectiveModel);
function reset(): void { if (props.scopeKind === 'conversation' && props.scopeId && effective.value) store.setThinkingForScope(props.scopeId, effective.value, null); }
</script>

<template>
  <div class="model-profile-save-status" aria-live="polite">
    <span v-if="pending?.status === 'saving'" role="status">保存中（仅当前范围）…</span>
    <span v-else-if="pending?.status === 'uncertain'" role="alert">保存结果未确定；原写入仍可能生效。</span>
    <span v-else-if="pending" role="status">未提交草稿</span>
    <span v-else-if="saved" role="status">已读取已保存值</span>
    <span v-else role="status">模型配置尚未确认</span>
    <span v-if="pending?.error || sendError || scopeError" role="alert">{{ pending?.error || sendError || scopeError }}</span>
    <span v-if="detached" role="alert">旧 authority/root 草稿已保留，未跨代提交：{{ detached.profile.model }}</span>
    <button v-if="pending?.status === 'draft'" type="button" @click="store.retryPending(scopeKind, scopeId)">确认重试</button>
    <button v-if="pending" type="button" :disabled="reading" @click="store.discardPending(scopeKind, scopeId)">放弃草稿并读取已保存值</button>
    <button type="button" :disabled="reading" @click="store.refreshScope(scopeKind, scopeId)">{{ reading ? '正在读取…' : '重新读取' }}</button>
    <button v-if="effective && scopeKind === 'conversation'" type="button" @click="reset">恢复思维默认</button>
    <button v-if="pending?.status === 'uncertain' || !saved || detached || scopeError" type="button" :disabled="reading" @click="store.refreshScope(scopeKind, scopeId, { adoptRoot: true })">显式连接当前配置根</button>
    <small v-if="pending">放弃草稿不会取消仍在途或撤销已提交的操作；确认原操作结束后读取实际值，不补偿回写。显式连接会重建本范围编辑会话并隔离旧排队写入，但不会撤销已经写入的内容。</small>
  </div>
</template>
<style scoped>
.model-profile-save-status { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; }
button { background: transparent; color: inherit; border: 1px solid var(--vscode-panel-border); cursor: pointer; }
[role=alert] { color: var(--vscode-errorForeground); }
small { opacity: .8; }
</style>

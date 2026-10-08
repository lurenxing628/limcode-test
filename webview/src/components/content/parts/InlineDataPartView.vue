<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { IconFile, IconRefresh, IconExternalLink } from '@tabler/icons-vue';
import type { AttachmentOpenResultPayload, InlineDataPart } from '@shared/protocol';
import { BridgeMessageType } from '@shared/protocol';
import { bridge } from '@webview/transport';
import { useInlineAttachmentDisplay } from '@webview/composables/useInlineAttachmentDisplay';
import CollapsibleContentBlock from '../CollapsibleContentBlock.vue';

const props = defineProps<{
  part: InlineDataPart;
}>();

const expanded = ref(props.part.inlineData.mimeType.startsWith('image/'));
const { inlineData, mimeType, displayName, sizeLabel, dataUri, loading, canReload, canOpen, contentRevision, requestData } =
  useInlineAttachmentDisplay(() => props.part, () => expanded.value || props.part.inlineData.mimeType.startsWith('image/'));
const opening = ref(false);
const pendingOpenRequestId = ref<string>('');
const openError = ref('');

const stopOpenListener = bridge.on(BridgeMessageType.AttachmentOpenResult, (message) => {
  if (!message.payload || message.correlationId !== pendingOpenRequestId.value) return;
  applyOpenResult(message.payload);
});

onBeforeUnmount(() => {
  stopOpenListener();
});

watch(contentRevision, () => {
  pendingOpenRequestId.value = '';
  opening.value = false;
  openError.value = '';
  expanded.value = props.part.inlineData.mimeType.startsWith('image/');
}, { flush: 'sync' });
const kind = computed<'image' | 'audio' | 'video' | 'pdf' | 'text' | 'file'>(() => {
  if (mimeType.value.startsWith('image/')) return 'image';
  if (mimeType.value.startsWith('audio/')) return 'audio';
  if (mimeType.value.startsWith('video/')) return 'video';
  if (mimeType.value === 'application/pdf') return 'pdf';
  if (mimeType.value === 'text/plain') return 'text';
  return 'file';
});
const statusText = computed(() => {
  if (loading.value || inlineData.value.status === 'loading') return '加载中';
  if (inlineData.value.status === 'missing') return '文件不存在';
  if (inlineData.value.status === 'failed') return '加载失败';
  if (inlineData.value.status === 'tooLarge') return '超过保存阈值';
  if (inlineData.value.status === 'unsupported') return '不支持的类型';
  return inlineData.value.data ? '已加载' : inlineData.value.sourcePath ? '本地文件引用' : inlineData.value.attachmentId ? '未加载' : '附件';
});
const decodedText = computed(() => {
  if (kind.value !== 'text' || !inlineData.value.data) return '';
  try {
    const binary = atob(inlineData.value.data);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '无法解码文本附件。';
  }
});

function setExpanded(value: boolean): void {
  expanded.value = value;
}

function reload(): void {
  requestData(true);
}

function openInVscode(): void {
  if (!canOpen.value || opening.value) return;
  opening.value = true;
  openError.value = '';
  pendingOpenRequestId.value = bridge.request(BridgeMessageType.AttachmentOpen, {
    attachmentId: inlineData.value.attachmentId,
    sourcePath: inlineData.value.sourcePath,
    data: inlineData.value.attachmentId || inlineData.value.sourcePath ? undefined : inlineData.value.data,
    mimeType: inlineData.value.mimeType,
    name: inlineData.value.name
  });
}

function applyOpenResult(payload: AttachmentOpenResultPayload): void {
  opening.value = false;
  pendingOpenRequestId.value = '';
  openError.value = payload.status === 'failed'
    ? payload.error || '无法打开附件。'
    : '';
}

</script>

<template>
  <CollapsibleContentBlock
    class="attachment-card"
    :expanded="expanded"
    kind="input"
    lazy
    :aria-label="expanded ? '收起附件内容' : '展开附件内容'"
    @update:expanded="setExpanded"
  >
    <template #icon>
      <IconFile stroke="2" aria-hidden="true" />
    </template>
    <template #summary>
      <span class="attachment-summary-name">{{ displayName }}</span>
      <span class="attachment-summary-meta">{{ mimeType }}<template v-if="sizeLabel"> · {{ sizeLabel }}</template> &nbsp;·&nbsp; {{ statusText }}</span>
    </template>
    <template #actions>
      <button v-if="canReload" type="button" class="attachment-action" :disabled="loading" title="重新加载附件" @click.stop="reload">
        <IconRefresh class="attachment-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        v-if="canOpen"
        type="button"
        class="attachment-action"
        :disabled="opening"
        :title="opening ? '正在打开附件' : '在 VS Code 标签页打开附件'"
        @click.stop="openInVscode"
      >
        <IconExternalLink class="attachment-action-icon" stroke="2" aria-hidden="true" />
      </button>
    </template>

    <div class="attachment-body" :class="`kind-${kind}`">
      <p v-if="loading || inlineData.status === 'loading'" class="attachment-state">附件加载中...</p>
      <template v-else-if="dataUri">
        <img
          v-if="kind === 'image'"
          class="attachment-image"
          :class="{ 'is-openable': canOpen }"
          :src="dataUri"
          :alt="displayName"
          @click="openInVscode"
        />
        <audio v-else-if="kind === 'audio'" class="attachment-media" :src="dataUri" controls></audio>
        <video v-else-if="kind === 'video'" class="attachment-video" :src="dataUri" controls></video>
        <object v-else-if="kind === 'pdf'" class="attachment-pdf" :data="dataUri" type="application/pdf">
          <p class="attachment-state">无法内嵌预览 PDF<template v-if="canOpen">，可点击右上角在 VS Code 中打开</template>。</p>
        </object>
        <pre v-else-if="kind === 'text'" class="attachment-text">{{ decodedText }}</pre>
        <p v-else class="attachment-state">该附件类型暂无内嵌预览<template v-if="canOpen">，可点击右上角在 VS Code 中打开</template>。</p>
      </template>
      <p v-else class="attachment-state is-error">
        {{ inlineData.error || (inlineData.status === 'missing' ? '附件文件不存在，可在文件恢复后重新加载。' : '附件尚未加载。') }}
      </p>
      <p v-if="openError" class="attachment-state is-error attachment-open-error">{{ openError }}</p>
    </div>
  </CollapsibleContentBlock>
</template>

<style scoped>
.attachment-card {
  --attachment-preview-max-height: 140px;
}

.attachment-summary-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.attachment-summary-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.attachment-action {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.attachment-action:hover:not(:disabled),
.attachment-action:focus-visible:not(:disabled) {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.attachment-action:disabled {
  opacity: 0.55;
}

.attachment-action-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}


.attachment-body {
  min-width: 0;
}

.attachment-image {
  display: block;
  width: 33%;
  max-width: 240px;
  max-height: var(--attachment-preview-max-height);
  border-radius: var(--radius-sm);
  object-fit: contain;
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.attachment-image.is-openable {
  cursor: zoom-in;
  transition: filter 0.15s ease;
}

.attachment-image.is-openable:hover {
  filter: brightness(1.08);
}

.attachment-media {
  display: block;
  width: 33%;
  max-width: 240px;
  max-height: var(--attachment-preview-max-height);
  border-radius: var(--radius-sm);
}

.attachment-video {
  display: block;
  width: 33%;
  max-width: 240px;
  max-height: var(--attachment-preview-max-height);
  border-radius: var(--radius-sm);
}

.attachment-pdf {
  display: block;
  width: 100%;
  max-height: var(--attachment-preview-max-height);
  min-height: 160px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.attachment-text {
  width: 100%;
  max-height: 360px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: var(--vscode-editor-font-size, 12px) / 1.5 var(--vscode-editor-font-family, monospace);
  color: var(--vscode-editor-foreground);
}

.attachment-state {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.attachment-open-error {
  margin-top: var(--space-2, 8px);
}

.attachment-state.is-error {
  color: var(--vscode-errorForeground, #f48771);
}
</style>

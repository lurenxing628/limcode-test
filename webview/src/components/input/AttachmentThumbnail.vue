<script setup lang="ts">
import type { InlineDataPart } from '@shared/protocol';
import { useInlineAttachmentDisplay } from '@webview/composables/useInlineAttachmentDisplay';

const props = defineProps<{ part: InlineDataPart }>();
const { dataUri, displayName, loading, inlineData } = useInlineAttachmentDisplay(() => props.part, () => true);
</script>

<template>
  <span class="attachment-thumbnail" :title="inlineData.error || displayName" :aria-label="loading ? '图片加载中' : displayName">
    <img v-if="dataUri" :src="dataUri" :alt="displayName" />
    <span v-else>{{ loading ? '…' : '图片' }}</span>
  </span>
</template>

<style scoped>
.attachment-thumbnail {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--vscode-editor-background);
  color: var(--vscode-descriptionForeground);
}

.attachment-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>

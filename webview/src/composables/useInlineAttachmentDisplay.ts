import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { BridgeMessageType, type InlineDataPart } from '@shared/protocol';
import { bridge } from '@webview/transport';
import { cachedInlineAttachmentPreview, rememberInlineAttachmentPreview } from './inlineAttachmentPreviewCache';

/** Preview bytes belong to this view, never to the persisted message or Composer draft. */
export function useInlineAttachmentDisplay(source: () => InlineDataPart, visible: () => boolean) {
  const localPart = ref<InlineDataPart>(initialPart(source()));
  const loading = ref(false);
  const contentRevision = ref(0);
  let reference = clonePart(source());
  let pendingRequestId = '';

  const inlineData = computed(() => localPart.value.inlineData);
  const mimeType = computed(() => inlineData.value.mimeType || 'application/octet-stream');
  const displayName = computed(() => inlineData.value.name || fileNameFromPath(inlineData.value.sourcePath)
    || inlineData.value.attachmentId || '内联附件');
  const sizeLabel = computed(() => formatBytes(inlineData.value.sizeBytes));
  const dataUri = computed(() => inlineData.value.data ? `data:${mimeType.value};base64,${inlineData.value.data}` : '');
  const canReload = computed(() => !!inlineData.value.attachmentId || !!inlineData.value.sourcePath);
  const canOpen = computed(() => canReload.value || !!inlineData.value.data);

  rememberInlineAttachmentPreview(localPart.value);

  const stopReloadListener = bridge.on(BridgeMessageType.AttachmentReloadResult, (message) => {
    if (!pendingRequestId || message.correlationId !== pendingRequestId || !message.payload) return;
    pendingRequestId = '';
    loading.value = false;
    if (message.payload.part) {
      localPart.value = clonePart(message.payload.part);
      rememberInlineAttachmentPreview(localPart.value);
      return;
    }
    const { data: _staleData, ...currentReference } = inlineData.value;
    localPart.value = { inlineData: {
      ...currentReference,
      status: message.payload.status,
      ...(message.payload.error ? { error: message.payload.error } : {})
    } };
  });

  watch(source, (incoming) => {
    const sameContent = sameAttachmentContent(reference, incoming);
    reference = clonePart(incoming);
    if (!sameContent) {
      pendingRequestId = '';
      loading.value = false;
      localPart.value = initialPart(incoming);
      contentRevision.value += 1;
    } else {
      // Feed metadata updates must not discard bytes already read for this exact attachment.
      const current = inlineData.value;
      const data = incoming.inlineData.data ?? current.data;
      localPart.value = { inlineData: {
        ...incoming.inlineData,
        ...(data ? { data } : {}),
        status: incoming.inlineData.data ? incoming.inlineData.status : current.status,
        ...(incoming.inlineData.data ? {} : current.error ? { error: current.error } : {})
      } };
      rememberInlineAttachmentPreview(localPart.value);
    }
    if (!sameContent && visible()) requestData();
  }, { deep: true, flush: 'sync' });

  watch(visible, (isVisible) => { if (isVisible) requestData(); }, { immediate: true, flush: 'sync' });

  onBeforeUnmount(() => {
    pendingRequestId = '';
    stopReloadListener();
    reference = { inlineData: { mimeType: '' } };
    localPart.value = reference;
  });

  function requestData(force = false): void {
    if (loading.value || (!force && inlineData.value.data) || !canReload.value) return;
    const cached = force ? undefined : cachedInlineAttachmentPreview(localPart.value);
    if (cached) {
      localPart.value = cached;
      rememberInlineAttachmentPreview(localPart.value);
      return;
    }
    loading.value = true;
    localPart.value = { inlineData: { ...inlineData.value, status: 'loading' } };
    pendingRequestId = bridge.request(BridgeMessageType.AttachmentReload, {
      attachmentId: inlineData.value.attachmentId,
      sourcePath: inlineData.value.sourcePath,
      mimeType: inlineData.value.mimeType,
      name: inlineData.value.name
    });
  }

  return { inlineData, mimeType, displayName, sizeLabel, dataUri, loading, canReload, canOpen, contentRevision, requestData };
}

function initialPart(part: InlineDataPart): InlineDataPart {
  const clone = clonePart(part);
  return clone.inlineData.data ? clone : cachedInlineAttachmentPreview(clone) ?? clone;
}

function clonePart(part: InlineDataPart): InlineDataPart {
  return { inlineData: { ...part.inlineData } };
}

function sameAttachmentContent(left: InlineDataPart, right: InlineDataPart): boolean {
  const a = left.inlineData, b = right.inlineData;
  if (a.mimeType !== b.mimeType || a.storage !== b.storage || a.sha256 !== b.sha256 || a.sizeBytes !== b.sizeBytes) return false;
  if (a.data !== undefined && b.data !== undefined && a.data !== b.data) return false;
  if (a.attachmentId || b.attachmentId) return a.attachmentId === b.attachmentId && a.sourcePath === b.sourcePath;
  if (a.sourcePath || b.sourcePath) return a.sourcePath === b.sourcePath;
  return a.data === b.data;
}

function fileNameFromPath(path: string | undefined): string {
  return path?.replace(/[\\/]+$/g, '').split(/[\\/]/).pop() ?? '';
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return mb < 1024 ? `${mb.toFixed(mb < 10 ? 1 : 0)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

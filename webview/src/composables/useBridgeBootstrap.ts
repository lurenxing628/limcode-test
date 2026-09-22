import { onBeforeUnmount, watch } from 'vue';
import {
  GLOBAL_SETTINGS_SECTIONS,
  type BridgeScope,
  type GlobalSettingsSection
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useSessionStore } from '@webview/stores/useSessionStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore, CHANNEL_SETTINGS_SECTIONS } from '@webview/stores/useGlobalSettingsStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import { useSystemPromptStore } from '@webview/stores/useSystemPromptStore';
import { useRuntimeContextStore } from '@webview/stores/useRuntimeContextStore';
import { useInteractionStore } from '@webview/stores/useInteractionStore';
import { useReliableKernelClientFeedStore } from '@webview/stores/useReliableKernelClientFeedStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { useAgentStore } from '@webview/stores/useAgentStore';

function globalSettingsSectionFromScope(scope: BridgeScope | undefined): GlobalSettingsSection | undefined {
  if (scope?.kind !== 'settings' || scope.level !== 'global') return undefined;
  const section = scope.id;
  return GLOBAL_SETTINGS_SECTIONS.includes(section as GlobalSettingsSection)
    ? section as GlobalSettingsSection
    : undefined;
}

/** Registers the configuration/control bridge. Runtime data is accepted only by the bounded Feed. */
export function useBridgeBootstrap(): void {
  const session = useSessionStore();
  const clientState = useClientStateStore();
  const globalSettings = useGlobalSettingsStore();
  const conversationSettings = useConversationSettingsStore();
  const systemPrompts = useSystemPromptStore();
  const runtimeContexts = useRuntimeContextStore();
  const interactions = useInteractionStore();
  const reliableFeed = useReliableKernelClientFeedStore();
  const modelProfiles = useModelProfileStore();
  const agents = useAgentStore();
  const disposers: Array<() => void> = [];
  // A retained Webview survives Extension Host restarts. Its one-time bootstrap Ready belonged to
  // the previous Feed client, so remember the Hello client identity and re-declare readiness once
  // when a replacement Host attaches. The reconnect Hello keeps the same id and cannot loop.
  let announcedClientId: string | undefined;

  disposers.push(
    bridge.on(BridgeMessageType.Hello, (message) => {
      const previousClientId = announcedClientId;
      if (message.clientId) announcedClientId = message.clientId;
      if (previousClientId && message.clientId && previousClientId !== message.clientId) {
        modelProfiles.reconnectScopes();
        globalSettings.reconcilePendingSettings();
        bridge.ready();
      }
      session.applyHello(message.payload?.meta, message.payload?.runtime);
      interactions.replayForClient(message.clientId ?? bridge.currentClientId(), message.id);
      if (message.payload?.runtime) console.info('[LimCode][Runtime]', { ...message.payload.runtime });
      const conversationId = message.payload?.meta?.conversationId;
      if (conversationId) clientState.setCurrentConversation(conversationId);

      if (session.viewKind === 'globalSettings') {
        globalSettings.requestAll();
        return;
      }
      globalSettings.requestChannelSettings();
      if (session.viewKind === 'chat' || session.viewKind === 'planDetail') {
        globalSettings.ensureAppearance();
      }
    }),
    bridge.on(BridgeMessageType.ConfigurationSnapshot, (message) => {
      if (!message.payload) return;
      modelProfiles.invalidateSnapshot(message.payload.state);
      clientState.applyConfigurationSnapshot(message.payload.state);
      systemPrompts.reconcilePendingSave();
      runtimeContexts.reconcilePendingSave();
    }),
    bridge.on(BridgeMessageType.ModelProfileScopeSnapshot, (message) => {
      if (message.payload) modelProfiles.applyScopeSnapshot(message.payload, message.correlationId);
    }),
    bridge.on(BridgeMessageType.InteractionResult, (message) => {
      if (message.payload) interactions.applyResult(message.payload, message.correlationId);
    }),
    bridge.on(BridgeMessageType.GlobalSettingsSnapshot, (message) => {
      if (message.payload) {
        globalSettings.applySnapshot(message.payload, message.correlationId);
        if (message.payload.section === 'llm' || message.payload.section === 'llmProviderConfigs') modelProfiles.invalidateActiveScopes();
      }
    }),
    bridge.on(BridgeMessageType.GlobalSettingsFlush, (message) => {
      const sections: readonly GlobalSettingsSection[] = session.viewKind === 'globalSettings'
        ? CHANNEL_SETTINGS_SECTIONS
        : ['llm'];
      void globalSettings.flushForExecution(sections).then(
        () => bridge.request(BridgeMessageType.GlobalSettingsFlushResult, { status: 'saved' }, { correlationId: message.id }),
        (error: unknown) => bridge.request(BridgeMessageType.GlobalSettingsFlushResult, {
          status: 'failed', message: error instanceof Error ? error.message : String(error)
        }, { correlationId: message.id })
      );
    }),
    bridge.on(BridgeMessageType.ConversationSettingsSnapshot, (message) => {
      if (message.payload) conversationSettings.applySnapshot(message.payload);
    }),
    bridge.on(BridgeMessageType.LlmProviderModelsSnapshot, (message) => {
      if (message.payload) globalSettings.applyLlmProviderModelsSnapshot(message.payload);
    }),
    bridge.on(BridgeMessageType.Error, (message) => {
      const payload = message.payload;
      if (!payload) return;
      if (payload.requestType === BridgeMessageType.InteractionResolve) {
        interactions.observeTransportError(message.correlationId, payload.message);
      }
      if (payload.requestType === BridgeMessageType.ModelProfileScopeSet
        || payload.requestType === BridgeMessageType.ModelProfileScopeClear
        || payload.requestType === BridgeMessageType.ModelProfileScopeRead) {
        modelProfiles.rejectRequest(message.correlationId, payload.message);
      }
      if (payload.requestType === BridgeMessageType.ConversationAgentSelect) {
        agents.rejectPending(message.correlationId, payload.message);
      }
      if (
        payload.requestType === BridgeMessageType.ConversationSettingsGet
        || payload.requestType === BridgeMessageType.ConversationSettingsUpdate
      ) {
        const scope = message.scope;
        conversationSettings.applyError({
          message: payload.message,
          conversationId: scope?.kind === 'settings' && scope.level === 'conversation' ? scope.id : undefined
        });
      }
      if (
        payload.requestType === BridgeMessageType.GlobalSettingsGet
        || payload.requestType === BridgeMessageType.GlobalSettingsUpdate
        || payload.requestType === BridgeMessageType.LlmProviderModelsGet
      ) {
        globalSettings.setError(payload.message, {
          requestType: payload.requestType,
          section: globalSettingsSectionFromScope(message.scope),
          correlationId: message.correlationId,
          ...(payload.code === 'settings_revision_conflict' ? { code: payload.code } : {}),
          actualRevision: payload.actualRevision
        });
      }
    })
  );

  disposers.push(
    watch(
      () => Object.values(reliableFeed.records.InteractionRequest ?? {})
        .map((request) => `${String(request.id ?? '')}:${String(request.status ?? '')}:${String(request.updated_at ?? '')}`)
        .sort()
        .join('|'),
      () => interactions.reconcileReliableFacts(
        Object.values(reliableFeed.records.InteractionRequest ?? {})
      ),
      { immediate: true }
    )
  );

  disposers.push(
    watch(
      [() => clientState.currentConversationId, () => session.viewKind],
      ([conversationId, viewKind]) => {
        if ((viewKind !== 'chat' && viewKind !== 'planDetail') || !conversationId) {
          conversationSettings.request('');
          return;
        }
        // Hello already carries the Feed's scoped Conversation. Reopening that same id would create
        // a second startup generation; only an actual in-panel navigation needs ConversationOpen.
        if (conversationId !== session.conversationId) {
          bridge.request(BridgeMessageType.ConversationOpen, { conversationId });
        }
        conversationSettings.request(conversationId);
      },
      { immediate: true }
    )
  );

  bridge.ready();
  onBeforeUnmount(() => {
    for (const dispose of disposers) dispose();
  });
}

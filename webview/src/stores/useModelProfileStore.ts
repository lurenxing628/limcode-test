import { defineStore } from 'pinia';
import { type ConfigScopeKind, type ChatModelOverrideRecord, type LlmProviderKind, type ModelProfileRecord, type ModelProfileScopeLinkRecord, type ModelProfileScopeSnapshotPayload, type SessionThinkingOverride } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

type Operation = 'select' | 'thinking' | 'reset' | 'inherit' | 'clear';
interface SelectionInput { name?: string; providerConfigId?: string; provider?: LlmProviderKind; model: string; thinkingOverride?: SessionThinkingOverride | null; inheritThinkingToChildren?: boolean; expectedEffectiveModel?: ChatModelOverrideRecord }
interface PendingModelProfileSelection {
  requestId: string;
  profile: ModelProfileRecord;
  operation: Operation;
  expectedEffectiveModel?: ChatModelOverrideRecord;
  status: 'draft' | 'saving' | 'uncertain';
  submitted?: { operation: Operation; profile: ModelProfileRecord; expectedRevision: string };
  queued?: boolean;
  error?: string;
}
interface Scope { scopeKind: ConfigScopeKind; scopeId?: string }
interface ReadState { requestId: string; authorityId?: string; sessionId?: string; afterRequestId?: string; discard: boolean; adopt: boolean; renew: boolean; dirty: boolean }
const waiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
function settle(key: string, error?: string): void { for (const waiter of waiters.get(key) ?? []) error ? waiter.reject(new Error(error)) : waiter.resolve(); waiters.delete(key); }
const scopeOf = (scopeKind: ConfigScopeKind, scopeId?: string): Scope => ({ scopeKind, ...(scopeKind !== 'global' && scopeId?.trim() ? { scopeId: scopeId.trim() } : {}) });
const keyOf = (scopeKind: ConfigScopeKind, scopeId?: string): string => JSON.stringify(scopeOf(scopeKind, scopeId));
const plainModel = (value: ChatModelOverrideRecord): ChatModelOverrideRecord => ({ providerConfigId: value.providerConfigId, provider: value.provider, model: value.model });
const plainThinking = (value: SessionThinkingOverride): SessionThinkingOverride => 'tokens' in value ? { kind: value.kind, tokens: value.tokens } : { kind: value.kind, value: value.value };
const sameScope = (link: ModelProfileScopeLinkRecord, scope: Scope): boolean => link.scopeKind === scope.scopeKind && (scope.scopeKind === 'global' || link.scopeId === scope.scopeId);

function matchesReceipt(payload: ModelProfileScopeSnapshotPayload, sent: PendingModelProfileSelection['submitted']): boolean {
  if (!sent || payload.operation !== sent.operation || payload.expectedRevision !== sent.expectedRevision) return false;
  const actual = payload.profile;
  const sameModel = !!actual && JSON.stringify(plainModel(actual)) === JSON.stringify(plainModel(sent.profile));
  switch (sent.operation) {
    case 'clear': return payload.profileState === 'absent';
    case 'reset':
      if (sent.profile.inheritModel && !sent.profile.inheritThinkingToChildren) return payload.profileState === 'absent';
      return payload.profileState === 'default' && sameModel
        && !!actual?.inheritModel === !!sent.profile.inheritModel
        && !!actual?.inheritThinkingToChildren === !!sent.profile.inheritThinkingToChildren;
    case 'inherit': return sameModel && actual?.inheritThinkingToChildren === sent.profile.inheritThinkingToChildren
      && JSON.stringify(actual?.thinkingOverride) === JSON.stringify(sent.profile.thinkingOverride);
    case 'select': return payload.profileState === 'default' && sameModel && !actual?.inheritModel;
    case 'thinking': return payload.profileState === 'overridden' && sameModel
      && !!actual?.inheritModel === !!sent.profile.inheritModel
      && JSON.stringify(actual?.thinkingOverride) === JSON.stringify(sent.profile.thinkingOverride);
  }
}

export const useModelProfileStore = defineStore('modelProfile', {
  state: () => ({ status: '', authorityId: '', adoptionRequestId: '', invalidationFingerprint: '',
    invalidationSequences: {} as Record<string, number>,
    scopeErrors: {} as Record<string, string>,
    failedReads: {} as Record<string, boolean>,
    observations: {} as Record<string, ModelProfileScopeSnapshotPayload>,
    activeScopes: {} as Record<string, { scope: Scope; users: number }>,
    reads: {} as Record<string, ReadState>,
    pendingSelections: {} as Record<string, PendingModelProfileSelection>,
    detachedDrafts: {} as Record<string, PendingModelProfileSelection> }),
  actions: {
    activateScope(scopeKind: ConfigScopeKind, scopeId?: string): () => void {
      const key = keyOf(scopeKind, scopeId), scope = scopeOf(scopeKind, scopeId);
      const active = this.activeScopes[key] ?? { scope, users: 0 }; active.users++; this.activeScopes[key] = active;
      this.refreshScope(scopeKind, scopeId);
      return () => { if (--active.users <= 0) delete this.activeScopes[key]; };
    },
    errorFor(scopeKind: ConfigScopeKind, scopeId?: string): string {
      const key = keyOf(scopeKind, scopeId);
      return this.scopeErrors[key] ?? this.pendingSelections[key]?.error ?? '';
    },
    confirmedFor(scopeKind: ConfigScopeKind, scopeId?: string): ModelProfileScopeSnapshotPayload | undefined { return this.observations[keyOf(scopeKind, scopeId)]; },
    effectiveFor(scopeKind: ConfigScopeKind, scopeId?: string): ChatModelOverrideRecord | undefined { return this.confirmedFor(scopeKind, scopeId)?.effectiveModel; },
    localProfileFor(scopeKind: ConfigScopeKind, scopeId?: string): { profile?: ModelProfileRecord; link?: ModelProfileScopeLinkRecord } {
      const key = keyOf(scopeKind, scopeId), pending = this.pendingSelections[key], saved = this.observations[key];
      if (pending && pending.operation !== 'clear') return { profile: pending.profile, link: saved?.link };
      return pending?.operation === 'clear' ? {} : { profile: saved?.profile, link: saved?.link };
    },
    pendingFor(scopeKind: ConfigScopeKind, scopeId?: string): PendingModelProfileSelection | undefined { return this.pendingSelections[keyOf(scopeKind, scopeId)]; },
    detachedFor(scopeKind: ConfigScopeKind, scopeId?: string): PendingModelProfileSelection | undefined { return this.detachedDrafts[keyOf(scopeKind, scopeId)]; },
    readingFor(scopeKind: ConfigScopeKind, scopeId?: string): boolean { return !!this.reads[keyOf(scopeKind, scopeId)]; },
    setProfileForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, input: SelectionInput): void { this.choose(scopeKind, scopeId, input, 'select'); },
    setThinkingForScope(conversationId: string, model: ChatModelOverrideRecord, thinkingOverride: SessionThinkingOverride | null, inheritThinkingToChildren?: boolean): void {
      this.choose('conversation', conversationId, { ...plainModel(model), thinkingOverride, inheritThinkingToChildren, expectedEffectiveModel: plainModel(model) }, thinkingOverride === null ? 'reset' : 'thinking');
    },
    setChildThinkingInheritance(conversationId: string, model: ChatModelOverrideRecord, enabled: boolean): void {
      this.choose('conversation', conversationId, { ...plainModel(model), inheritThinkingToChildren: enabled, expectedEffectiveModel: plainModel(model) }, 'inherit');
    },
    thinkingFor(scopeKind: ConfigScopeKind, scopeId?: string): SessionThinkingOverride | undefined {
      const profile = this.localProfileFor(scopeKind, scopeId).profile;
      const effective = this.effectiveFor(scopeKind, scopeId);
      return profile && effective && JSON.stringify(plainModel(profile)) === JSON.stringify(plainModel(effective))
        ? profile.thinkingOverride : undefined;
    },
    childThinkingInheritanceFor(scopeKind: ConfigScopeKind, scopeId?: string): boolean {
      return this.localProfileFor(scopeKind, scopeId).profile?.inheritThinkingToChildren === true;
    },
    choose(scopeKind: ConfigScopeKind, scopeId: string | undefined, input: SelectionInput, operation: Operation): void {
      const key = keyOf(scopeKind, scopeId), prior = this.pendingSelections[key], saved = this.observations[key];
      const sameSelectedModel = saved?.effectiveModel && saved.effectiveModel.providerConfigId === input.providerConfigId
        && saved.effectiveModel.provider === input.provider && saved.effectiveModel.model === input.model;
      if (operation === 'select' && sameSelectedModel && !prior) return;
      settle(key, '选择已更新，请再次发送。');
      const profile: ModelProfileRecord = { id: saved?.profile?.id ?? `draft:${key}`, name: input.name || saved?.profile?.name || 'LLM 配置', ...plainModel(input),
        ...(operation !== 'select' && (!saved?.profile || saved.profile.inheritModel) ? { inheritModel: true } : {}),
        ...(input.inheritThinkingToChildren !== undefined || saved?.profile?.inheritThinkingToChildren !== undefined
          ? { inheritThinkingToChildren: input.inheritThinkingToChildren ?? saved?.profile?.inheritThinkingToChildren }
          : {}),
        ...(operation === 'inherit' && this.thinkingFor(scopeKind, scopeId) ? { thinkingOverride: plainThinking(this.thinkingFor(scopeKind, scopeId)!) } : {}),
        ...(operation === 'thinking' && input.thinkingOverride ? { thinkingOverride: plainThinking(input.thinkingOverride) } : {}) };
      this.pendingSelections[key] = { requestId: prior?.requestId ?? '', profile, operation,
        ...(input.expectedEffectiveModel ? { expectedEffectiveModel: plainModel(input.expectedEffectiveModel) } : {}),
        status: prior?.status ?? 'draft', submitted: prior?.submitted, queued: prior?.status === 'saving', ...(prior?.error ? { error: prior.error } : {}) };
      if (prior?.status === 'saving' || prior?.status === 'uncertain') return;
      if (!saved) { this.refreshScope(scopeKind, scopeId); return; }
      this.sendDraft(scopeKind, scopeId);
    },
    sendDraft(scopeKind: ConfigScopeKind, scopeId?: string): void {
      const key = keyOf(scopeKind, scopeId), pending = this.pendingSelections[key], saved = this.observations[key];
      if (!pending || !saved || pending.status !== 'draft' || saved.authorityId !== this.authorityId) return;
      const base = { ...scopeOf(scopeKind, scopeId), authorityId: saved.authorityId, sessionId: saved.sessionId, expectedRevision: saved.revision };
      const profile = pending.profile;
      const payload = pending.operation === 'clear' ? base : { ...base, operation: pending.operation, name: profile.name,
        ...plainModel(profile), ...(pending.expectedEffectiveModel ? { expectedEffectiveModel: plainModel(pending.expectedEffectiveModel) } : {}),
        ...(pending.operation === 'inherit' ? { inheritThinkingToChildren: profile.inheritThinkingToChildren === true } : {}),
        ...(pending.operation === 'thinking' && profile.thinkingOverride ? { thinkingOverride: plainThinking(profile.thinkingOverride) } : {}),
        ...(pending.operation === 'reset' ? { thinkingOverride: null } : {}) };
      const requestId = bridge.request(pending.operation === 'clear' ? BridgeMessageType.ModelProfileScopeClear : BridgeMessageType.ModelProfileScopeSet, payload);
      pending.submitted = { operation: pending.operation, expectedRevision: saved.revision, profile: { ...profile, ...(profile.thinkingOverride ? { thinkingOverride: plainThinking(profile.thinkingOverride) } : {}), ...(profile.inheritThinkingToChildren !== undefined ? { inheritThinkingToChildren: profile.inheritThinkingToChildren } : {}) } };
      pending.requestId = requestId; pending.status = 'saving'; pending.queued = false; delete pending.error;
      this.status = '正在保存 LLM 配置…';
      setTimeout(() => { if (this.pendingSelections[key]?.requestId === requestId && this.pendingSelections[key]?.status === 'saving') this.rejectPending(requestId, '保存结果未确定；原操作仍可能在途。请重新读取确认，不会自动重发。'); }, 10000);
    },
    async awaitSavedForScope(scopeKind: ConfigScopeKind, scopeId?: string): Promise<void> {
      const key = keyOf(scopeKind, scopeId), pending = this.pendingSelections[key];
      if (!pending) return;
      if (pending.error || pending.status === 'uncertain') throw new Error(pending.error || '保存结果未确定，请重新读取。');
      await new Promise<void>((resolve, reject) => { const list = waiters.get(key) ?? []; list.push({ resolve, reject }); waiters.set(key, list); });
    },
    refreshScope(scopeKind: ConfigScopeKind, scopeId?: string, options: { discard?: boolean; adoptRoot?: boolean } = {}): void {
      const key = keyOf(scopeKind, scopeId), pending = this.pendingSelections[key];
      const existing = this.reads[key];
      if (existing && !options.adoptRoot) { existing.dirty = true; existing.discard ||= options.discard === true; return; }
      const adopt = options.adoptRoot === true || !this.authorityId;
      const afterRequestId = !options.adoptRoot && pending?.requestId ? pending.requestId : undefined;
      const sessionId = !options.adoptRoot ? this.observations[key]?.sessionId : undefined;
      const requestId = bridge.request(BridgeMessageType.ModelProfileScopeRead, { ...scopeOf(scopeKind, scopeId),
        ...(sessionId ? { sessionId } : {}), ...(options.adoptRoot ? { renewSession: true } : {}),
        ...(!adopt && this.authorityId ? { authorityId: this.authorityId } : {}), ...(afterRequestId ? { afterRequestId } : {}) });
      this.reads[key] = { requestId, sessionId, ...(adopt ? {} : { authorityId: this.authorityId }), afterRequestId, discard: options.discard === true, adopt, renew: options.adoptRoot === true, dirty: false };
      if (adopt) this.adoptionRequestId = requestId;
      setTimeout(() => {
        if (this.reads[key]?.requestId !== requestId) return;
        delete this.reads[key];
        this.status = '读取未确认；保留草稿，请重新读取。';
        this.scopeErrors[key] = this.status;
        this.failedReads[key] = true;
        if (this.pendingSelections[key]) this.rejectPending(this.pendingSelections[key].requestId, this.status);
      }, 10000);
    },
    applyScopeSnapshot(payload: ModelProfileScopeSnapshotPayload, correlationId?: string): void {
      const key = keyOf(payload.scopeKind, payload.scopeId), read = this.reads[key], pending = this.pendingSelections[key];
      const isRead = !!correlationId && read?.requestId === correlationId;
      const isWrite = !!correlationId && pending?.requestId === correlationId;
      const previousObservation = this.observations[key];
      if (!correlationId) {
        if (!this.activeScopes[key] || !this.authorityId || payload.authorityId !== this.authorityId
          || !Number.isSafeInteger(payload.sequence) || !payload.revision || payload.outcome !== 'committed'
          || payload.sequence <= Math.max(previousObservation?.sequence ?? 0, this.invalidationSequences[key] ?? 0)) return;
        this.invalidationSequences[key] = payload.sequence;
        this.refreshScope(payload.scopeKind, payload.scopeId);
        return;
      }
      if (!isRead && !isWrite) return;
      if (isRead) delete this.reads[key];
      // An after-read belongs to one submitted operation, not a newer queued selection that
      // started while the host was reading. It must not detach that newer in-flight request.
      if (isRead && read.afterRequestId && pending?.requestId !== read.afterRequestId) return;
      if (payload.outcome === 'uncertain' || !payload.revision || !payload.authorityId || !payload.sessionId) {
        this.status = payload.error || '结果未确定，请重新读取。';
        this.scopeErrors[key] = this.status;
        if (isRead) this.failedReads[key] = true;
        if (pending) { pending.status = 'uncertain'; pending.error = this.status; settle(key, this.status); }
        return;
      }
      if (isRead && read.sessionId && read.sessionId !== payload.sessionId) return;
      if (isWrite && (previousObservation?.sessionId !== payload.sessionId || payload.authorityId !== this.authorityId)) return;
      const actual = payload.profile;
      const validPair = actual && payload.link?.modelProfileId === actual.id && sameScope(payload.link, scopeOf(payload.scopeKind, payload.scopeId));
      const actualState = !actual && !payload.link ? 'absent' : validPair ? actual.thinkingOverride ? 'overridden' : 'default' : undefined;
      if (!actualState || payload.profileState !== actualState || payload.outcome !== (isWrite ? 'committed' : 'observed')) {
        const message = '配置确认状态不完整；结果未确定，请重新读取。';
        this.scopeErrors[key] = message;
        if (isWrite) this.rejectPending(correlationId, message);
        return;
      }
      if (isWrite) {
        if (!matchesReceipt(payload, pending?.submitted)) { this.rejectPending(correlationId, '保存确认内容不匹配；结果未确定，请重新读取。'); return; }
      }
      if (payload.authorityId !== this.authorityId) {
        if (!isRead || !read.adopt || this.adoptionRequestId !== correlationId) return;
        for (const [draftKey, draft] of Object.entries(this.pendingSelections)) {
          if (this.authorityId) { this.detachedDrafts[draftKey] = draft; settle(draftKey, 'authority/root 已改变；旧草稿保留，未跨代提交。'); delete this.pendingSelections[draftKey]; }
        }
        this.authorityId = payload.authorityId; this.observations = {};
        const client = useClientStateStore(); client.modelProfiles = []; client.modelProfileScopeLinks = [];
      }
      if (isRead && read.authorityId && read.authorityId !== payload.authorityId) return;
      if (isRead && read.afterRequestId && payload.afterRequestId !== read.afterRequestId) return;
      if (isRead && read.renew && this.pendingSelections[key]) {
        this.detachedDrafts[key] = this.pendingSelections[key]; delete this.pendingSelections[key];
        settle(key, '编辑会话已显式重建；旧草稿保留，未自动提交。');
      }
      const before = this.observations[key];
      if (before && payload.sequence <= before.sequence) return;
      // Only this guarded path updates profile/link consumers; full snapshots are invalidations.
      delete this.scopeErrors[key];
      delete this.failedReads[key];
      this.observations[key] = payload;
      const client = useClientStateStore();
      const oldIds = new Set(client.modelProfileScopeLinks.filter(link => sameScope(link, scopeOf(payload.scopeKind, payload.scopeId))).map(link => link.modelProfileId));
      client.modelProfileScopeLinks = [...client.modelProfileScopeLinks.filter(link => !sameScope(link, scopeOf(payload.scopeKind, payload.scopeId))), ...(payload.link ? [{ ...payload.link }] : [])];
      const retained = new Set(client.modelProfileScopeLinks.map(link => link.modelProfileId));
      client.modelProfiles = [...client.modelProfiles.filter(profile => (!oldIds.has(profile.id) || retained.has(profile.id)) && profile.id !== payload.profile?.id), ...(payload.profile ? [{ ...payload.profile }] : [])];
      const current = this.pendingSelections[key];
      if (isWrite && payload.outcome === 'committed' && current?.requestId === correlationId) {
        if (current.queued) { current.status = 'draft'; current.requestId = ''; this.sendDraft(payload.scopeKind, payload.scopeId); }
        else { delete this.pendingSelections[key]; settle(key); this.status = '已保存'; }
      } else if (isRead && current) {
        if (read.discard) { delete this.pendingSelections[key]; settle(key, '已放弃草稿并读取当前已保存值；未撤销已提交操作。'); this.status = '已读取已保存值；未撤销已提交操作'; }
        else if (read.afterRequestId) { current.status = 'draft'; current.requestId = ''; current.error = '已确认原操作结束并读取实际值；草稿保留，请确认后重试或放弃。'; settle(key, current.error); }
        else if (current.status === 'draft' && !current.error) this.sendDraft(payload.scopeKind, payload.scopeId);
      }
      if (isRead && read.dirty && !this.pendingSelections[key]) this.refreshScope(payload.scopeKind, payload.scopeId);
      // An initial/adopt read establishes the root; other active scopes may now observe it.
      if (isRead && read.adopt) for (const [activeKey, active] of Object.entries(this.activeScopes)) if (activeKey !== key && !this.observations[activeKey] && !this.reads[activeKey]) this.refreshScope(active.scope.scopeKind, active.scope.scopeId);
    },
    invalidateSnapshot(state: { modelProfiles: ModelProfileRecord[]; modelProfileScopeLinks: ModelProfileScopeLinkRecord[]; conversationWorkflowSelections?: unknown; agents?: unknown; workflows?: unknown }): void {
      const fingerprint = JSON.stringify([state.modelProfiles, state.modelProfileScopeLinks, state.conversationWorkflowSelections, state.agents, state.workflows]);
      if (fingerprint === this.invalidationFingerprint) return;
      this.invalidationFingerprint = fingerprint;
      this.invalidateActiveScopes();
    },
    invalidateActiveScopes(): void { for (const active of Object.values(this.activeScopes)) this.refreshScope(active.scope.scopeKind, active.scope.scopeId); },
    reconnectScopes(): void {
      for (const [key, draft] of Object.entries(this.pendingSelections)) {
        this.detachedDrafts[key] = draft;
        settle(key, '连接已更换；未确认的草稿已保留，请核对当前配置。');
      }
      this.pendingSelections = {};
      this.reads = {};
      this.observations = {};
      this.scopeErrors = {};
      this.failedReads = {};
      this.invalidationSequences = {};
      this.authorityId = '';
      this.adoptionRequestId = '';
      const client = useClientStateStore();
      client.modelProfiles = [];
      client.modelProfileScopeLinks = [];
      this.invalidateActiveScopes();
    },
    rejectRequest(correlationId: string | undefined, message: string): void {
      if (!correlationId) return;
      for (const [key, read] of Object.entries(this.reads)) {
        if (read.requestId !== correlationId) continue;
        delete this.reads[key];
        this.scopeErrors[key] = message;
        this.failedReads[key] = true;
        this.status = message;
        const pending = this.pendingSelections[key];
        if (pending) { pending.status = 'uncertain'; pending.error = message; settle(key, message); }
      }
      this.rejectPending(correlationId, message);
    },
    rejectPending(correlationId: string | undefined, message: string): void {
      if (!correlationId) return;
      for (const [key, pending] of Object.entries(this.pendingSelections)) if (pending.requestId === correlationId) { pending.status = 'uncertain'; pending.error = message; this.status = message; settle(key, message); }
    },
    retryPending(scopeKind: ConfigScopeKind, scopeId?: string): void {
      const pending = this.pendingFor(scopeKind, scopeId); if (!pending) return;
      // A failed reconciliation read may belong to an expired editing session. Renew it
      // explicitly, retaining the old draft without replaying an uncertain write.
      if (this.failedReads[keyOf(scopeKind, scopeId)]) { this.refreshScope(scopeKind, scopeId, { adoptRoot: true }); return; }
      if (pending.status === 'uncertain' || pending.requestId) { this.refreshScope(scopeKind, scopeId); return; }
      delete pending.error; this.sendDraft(scopeKind, scopeId);
    },
    discardPending(scopeKind: ConfigScopeKind, scopeId?: string): void {
      const key = keyOf(scopeKind, scopeId), pending = this.pendingSelections[key]; if (!pending) return;
      if (pending.requestId) { this.refreshScope(scopeKind, scopeId, { discard: true }); return; }
      delete this.pendingSelections[key]; settle(key, '未提交草稿已放弃；已保存配置未改动。');
    },
    clearProfileScope(scopeKind: ConfigScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      this.choose(scopeKind, scopeId, { model: '' }, 'clear');
    }
  }
});

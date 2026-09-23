import type { ClientState, ClientStateTableKey, ContentPart, MessageMaterializationStatus } from './protocol';

export type ClientStatePatchOperation = 'upsert' | 'append' | 'remove';
export type ClientStatePatchMode = 'generic' | 'custom';
export type ClientStateDiffMode = 'generic' | 'custom';

export interface ClientStatePayloadPatchSpec {
  readonly kind: string;
  readonly payloadField: string;
}

export interface ClientStateRemovePatchSpec {
  readonly kind: string;
}

export interface ClientStateTablePatchSpec {
  readonly upsert?: ClientStatePayloadPatchSpec;
  readonly append?: ClientStatePayloadPatchSpec;
  readonly remove?: ClientStateRemovePatchSpec;
}

export interface ClientStateSortSpec {
  readonly field: string;
  readonly direction?: 'asc' | 'desc';
}

export interface ClientStateCascadeRemoveSpec {
  readonly table: ClientStateTableKey;
  readonly foreignKey?: string;
  readonly foreignKeys?: readonly string[];
  /** true 时先按 child id 递归执行 child 表自己的 cascadeRemove，再删除 child 记录。 */
  readonly cascade?: boolean;
}

export type ClientStateScopeReplaceMode = 'replace' | 'upsertOnly' | 'removeOnly';
export interface ClientStateScopeOptions {
  readonly replace?: ClientStateScopeReplaceMode;
}

export type ClientStateScopeSpec =
  | ({ readonly kind: 'global' } & ClientStateScopeOptions)
  | ({ readonly kind: 'conversation'; readonly field: string } & ClientStateScopeOptions)
  | ({ readonly kind: 'conversationAny'; readonly fields: readonly string[] } & ClientStateScopeOptions)
  | {
      readonly kind: 'conversationVia';
      readonly table: ClientStateTableKey;
      readonly localField: string;
      readonly foreignField: string;
    } & ClientStateScopeOptions
  | {
      readonly kind: 'conversationReverseVia';
      readonly table: ClientStateTableKey;
      readonly localField: string;
      readonly foreignField: string;
    } & ClientStateScopeOptions
  | ({ readonly kind: 'conversationAnyOf'; readonly scopes: readonly ClientStateScopeSpec[] } & ClientStateScopeOptions);

export type ClientStateMutationPathSegment = string | { readonly fromField: string };

export type ClientStateMutationApplySpec =
  | {
      readonly op: 'setPath';
      readonly path: readonly ClientStateMutationPathSegment[];
      readonly valueField: string;
    }
  | {
      readonly op: 'appendStringAtPath';
      readonly path: readonly ClientStateMutationPathSegment[];
      readonly valueField: string;
    }
  | {
      readonly op: 'insertArrayItem';
      readonly path: readonly ClientStateMutationPathSegment[];
      readonly indexField: string;
      readonly itemField: string;
    };

export interface ClientStateMutationSpec<TKind extends string = string, TPayload extends { id: string } = { id: string }> {
  readonly kind: TKind;
  readonly apply: ClientStateMutationApplySpec;
  /** 类型占位字段，不在运行时写入。用于从注册表推导 ClientPatchOp。 */
  readonly __payload?: TPayload;
}

export interface ClientStateTableClientSyncSpec {
  /** 是否由 ClientSync 注册表自动生成 prev/next 的 patch diff。 */
  readonly diff: ClientStateDiffMode;
  /** 前端对应 patch 操作能否用通用 upsert/append/remove 处理。 */
  readonly apply: Readonly<Partial<Record<ClientStatePatchOperation, ClientStatePatchMode>>>;
  /** 记录内部 mutation patch，由后端领域模块决定何时发，前端机械执行。 */
  readonly mutations?: readonly ClientStateMutationSpec[];
  /** 通用 apply 后自动排序。 */
  readonly orderBy?: readonly ClientStateSortSpec[];
  /** 通用 remove 时按外键级联删除。 */
  readonly cascadeRemove?: readonly ClientStateCascadeRemoveSpec[];
  /** 预留给后续按 stream/scope 自动替换状态使用。 */
  readonly scope?: ClientStateScopeSpec;
  /** 删除本表记录前，先按该记录 id 清理某类 scope 下的记录。 */
  readonly removeScope?: { readonly kind: 'conversation' };
  /** global client state stream 的 snapshot 是否包含该表。 */
  readonly globalSnapshot: boolean;
}

export interface ClientStateTableSpec {
  readonly patch: ClientStateTablePatchSpec;
  readonly clientSync: ClientStateTableClientSyncSpec;
}

export type ClientStateTableRegistry = {
  readonly [TKey in ClientStateTableKey]: ClientStateTableSpec;
};

interface ClientSyncOverrides {
  readonly diff?: ClientStateDiffMode;
  readonly apply?: Readonly<Partial<Record<ClientStatePatchOperation, ClientStatePatchMode>>>;
  readonly mutations?: readonly ClientStateMutationSpec[];
  readonly orderBy?: readonly ClientStateSortSpec[];
  readonly cascadeRemove?: readonly ClientStateCascadeRemoveSpec[];
  readonly scope?: ClientStateScopeSpec;
  readonly removeScope?: { readonly kind: 'conversation' };
  readonly globalSnapshot?: boolean;
}

type UpsertRemoveTableSpec<TPatchPrefix extends string, TPayloadField extends string> = {
  readonly patch: {
    readonly upsert: {
      readonly kind: `${TPatchPrefix}.upsert`;
      readonly payloadField: TPayloadField;
    };
    readonly remove: {
      readonly kind: `${TPatchPrefix}.remove`;
    };
  };
  readonly clientSync: ClientStateTableClientSyncSpec;
};

type AppendRemoveTableSpec<TPatchPrefix extends string, TPayloadField extends string> = {
  readonly patch: {
    readonly append: {
      readonly kind: `${TPatchPrefix}.append`;
      readonly payloadField: TPayloadField;
    };
    readonly remove: {
      readonly kind: `${TPatchPrefix}.remove`;
    };
  };
  readonly clientSync: ClientStateTableClientSyncSpec;
};

function clientSyncSpec(defaultApply: Readonly<Partial<Record<ClientStatePatchOperation, ClientStatePatchMode>>>, overrides: ClientSyncOverrides = {}): ClientStateTableClientSyncSpec {
  return {
    diff: overrides.diff ?? 'generic',
    apply: { ...defaultApply, ...overrides.apply },
    ...(overrides.mutations ? { mutations: overrides.mutations } : {}),
    ...(overrides.orderBy ? { orderBy: overrides.orderBy } : {}),
    ...(overrides.cascadeRemove ? { cascadeRemove: overrides.cascadeRemove } : {}),
    ...(overrides.scope ? { scope: overrides.scope } : {}),
    ...(overrides.removeScope ? { removeScope: overrides.removeScope } : {}),
    globalSnapshot: overrides.globalSnapshot ?? !overrides.scope
  };
}

function upsertRemoveTable<const TPatchPrefix extends string, const TPayloadField extends string>(
  patchPrefix: TPatchPrefix,
  payloadField: TPayloadField,
  clientSync: ClientSyncOverrides = {}
): UpsertRemoveTableSpec<TPatchPrefix, TPayloadField> {
  return {
    patch: {
      upsert: { kind: `${patchPrefix}.upsert`, payloadField },
      remove: { kind: `${patchPrefix}.remove` }
    },
    clientSync: clientSyncSpec({ upsert: 'generic', remove: 'generic' }, clientSync)
  };
}

function appendRemoveTable<const TPatchPrefix extends string, const TPayloadField extends string>(
  patchPrefix: TPatchPrefix,
  payloadField: TPayloadField,
  clientSync: ClientSyncOverrides = {}
): AppendRemoveTableSpec<TPatchPrefix, TPayloadField> {
  return {
    patch: {
      append: { kind: `${patchPrefix}.append`, payloadField },
      remove: { kind: `${patchPrefix}.remove` }
    },
    clientSync: clientSyncSpec({ append: 'generic', remove: 'generic' }, clientSync)
  };
}

function mutation<const TKind extends string, TPayload extends { id: string }>(
  kind: TKind,
  apply: ClientStateMutationApplySpec
): ClientStateMutationSpec<TKind, TPayload> {
  return { kind, apply } as ClientStateMutationSpec<TKind, TPayload>;
}

const messageMutations = [
  mutation<'message.status', { id: string; status: MessageMaterializationStatus }>('message.status', {
    op: 'setPath',
    path: ['status'],
    valueField: 'status'
  }),
  mutation<'message.partThoughtElapsed.set', { id: string; partIndex: number; elapsedMs: number }>('message.partThoughtElapsed.set', {
    op: 'setPath',
    path: ['content', 'parts', { fromField: 'partIndex' }, 'thoughtElapsedMs'],
    valueField: 'elapsedMs'
  }),
  mutation<'message.partText.append', { id: string; partIndex: number; delta: string }>('message.partText.append', {
    op: 'appendStringAtPath',
    path: ['content', 'parts', { fromField: 'partIndex' }, 'text'],
    valueField: 'delta'
  }),
  mutation<'message.part.insert', { id: string; index: number; part: ContentPart }>('message.part.insert', {
    op: 'insertArrayItem',
    path: ['content', 'parts'],
    indexField: 'index',
    itemField: 'part'
  })
] as const;

const conversationScopedTable: ClientSyncOverrides = { globalSnapshot: false, scope: { kind: 'conversation', field: 'conversationId' } };
const messageTable = {
  diff: 'custom' as const,
  apply: { upsert: 'generic' as const, remove: 'generic' as const },
  mutations: messageMutations,
  orderBy: [{ field: 'seq' }],
  cascadeRemove: [
    { table: 'messageRevisions', foreignKey: 'messageId' },
    { table: 'messageCurrentRevisionLinks', foreignKey: 'messageId' },
    { table: 'messageTurnLinks', foreignKey: 'messageId' },
    { table: 'checkpointTimelineAnchors', foreignKey: 'floorMessageId' },
    { table: 'toolCalls', foreignKey: 'messageId', cascade: true },
    { table: 'toolCallPreviewTargetLinks', foreignKey: 'messageId' }
  ],
  globalSnapshot: false,
  scope: { kind: 'conversation' as const, field: 'conversationId' }
} as const satisfies ClientStateTableClientSyncSpec;
const toolCallsTable: ClientSyncOverrides = {
  cascadeRemove: [
    { table: 'toolCallRunLinks', foreignKey: 'toolCallId' },
    { table: 'toolCallEvents', foreignKey: 'toolCallId' },
    { table: 'toolCallResultLinks', foreignKey: 'toolCallId' },
    { table: 'interactionOwnerLinks', foreignKey: 'sourceToolCallId' }
  ],
  globalSnapshot: false,
  scope: {
    kind: 'conversationAnyOf',
    scopes: [
      { kind: 'conversationVia', table: 'messages', localField: 'messageId', foreignField: 'id' },
      { kind: 'conversationReverseVia', table: 'toolCallRunLinks', localField: 'id', foreignField: 'toolCallId' }
    ]
  }
};
const toolCallEventsTable: ClientSyncOverrides = {
  orderBy: [{ field: 'seq' }, { field: 'id' }],
  globalSnapshot: false,
  scope: { kind: 'conversationVia', table: 'toolCalls', localField: 'toolCallId', foreignField: 'id' }
};
const agentRunsTable: ClientSyncOverrides = {
  cascadeRemove: [
    { table: 'agentRunSourceLinks', foreignKey: 'runId' },
    { table: 'agentRunTargetLinks', foreignKey: 'runId' },
    { table: 'runTerminations', foreignKey: 'runId' },
    { table: 'toolCallRunLinks', foreignKey: 'runId' },
    { table: 'runWorkflowLinks', foreignKey: 'runId' },
    { table: 'runSystemPromptLinks', foreignKey: 'runId' },
    { table: 'runModelProfileLinks', foreignKey: 'runId' },
    { table: 'runToolPolicyLinks', foreignKey: 'runId' },
    { table: 'runRuntimeContextSnapshotLinks', foreignKey: 'runId' },
    { table: 'systemPromptScopeLinks', foreignKey: 'scopeId' },
    { table: 'modelProfileScopeLinks', foreignKey: 'scopeId' },
    { table: 'runtimeContextScopeLinks', foreignKey: 'scopeId' },
    { table: 'runConversationPolicyLinks', foreignKey: 'runId' },
    { table: 'runContextPolicyLinks', foreignKey: 'runId' },
    { table: 'runDeliveryPolicyLinks', foreignKey: 'runId' },
    { table: 'runEditPolicyLinks', foreignKey: 'runId' },
    { table: 'runWorkEnvironmentLinks', foreignKey: 'runId' },
    { table: 'agentRunInputRevisions', foreignKey: 'runId' },
    { table: 'runCompressionBlockLinks', foreignKey: 'runId' },
    { table: 'runPlanProposalLinks', foreignKey: 'runId' },
    { table: 'interactionOwnerLinks', foreignKey: 'turnId' },
    { table: 'interactionResponses', foreignKey: 'ownerTurnId' }
  ],
  scope: {
    kind: 'conversationAnyOf',
    replace: 'upsertOnly',
    scopes: [
      { kind: 'conversationReverseVia', table: 'agentRunTargetLinks', localField: 'id', foreignField: 'runId' },
      { kind: 'conversationReverseVia', table: 'agentRunSourceLinks', localField: 'id', foreignField: 'runId' },
      { kind: 'conversationReverseVia', table: 'messageTurnLinks', localField: 'id', foreignField: 'turnId' },
      { kind: 'conversationReverseVia', table: 'toolCallRunLinks', localField: 'id', foreignField: 'runId' }
    ]
  }
};

export const CLIENT_STATE_TABLES = {
  agents: upsertRemoveTable('agent', 'agent', {
    cascadeRemove: [
      { table: 'agentConversationLinks', foreignKey: 'agentId' },
      { table: 'conversationAgentSelections', foreignKey: 'agentId' },
      { table: 'toolPolicyScopeLinks', foreignKey: 'scopeId' },
      { table: 'skillPolicyScopeLinks', foreignKey: 'scopeId' },
      { table: 'systemPromptScopeLinks', foreignKey: 'scopeId' },
      { table: 'modelProfileScopeLinks', foreignKey: 'scopeId' },
      { table: 'runtimeContextScopeLinks', foreignKey: 'scopeId' },
      { table: 'workEnvironmentPolicyScopeLinks', foreignKey: 'scopeId' },
      { table: 'planReviewPolicyScopeLinks', foreignKey: 'scopeId' }
    ]
  }),
  toolDefinitions: upsertRemoveTable('toolDefinition', 'toolDefinition'),
  mcpToolSources: upsertRemoveTable('mcpToolSource', 'source'),
  workflows: upsertRemoveTable('workflow', 'workflow', {
    cascadeRemove: [
      { table: 'conversationWorkflowSelections', foreignKey: 'workflowId' },
      { table: 'runWorkflowLinks', foreignKey: 'workflowId' },
      { table: 'skillPolicyScopeLinks', foreignKey: 'scopeId' },
      { table: 'systemPromptScopeLinks', foreignKey: 'scopeId' },
      { table: 'modelProfileScopeLinks', foreignKey: 'scopeId' },
      { table: 'runtimeContextScopeLinks', foreignKey: 'scopeId' },
      { table: 'workEnvironmentPolicyScopeLinks', foreignKey: 'scopeId' },
      { table: 'planReviewPolicyScopeLinks', foreignKey: 'scopeId' }
    ]
  }),
  planReviewPolicies: upsertRemoveTable('planReviewPolicy', 'policy', {
    cascadeRemove: [{ table: 'planReviewPolicyScopeLinks', foreignKey: 'planReviewPolicyId' }],
    globalSnapshot: true
  }),
  planReviewPolicyScopeLinks: upsertRemoveTable('planReviewPolicyScopeLink', 'link', { globalSnapshot: true }),
  planProposals: upsertRemoveTable('planProposal', 'proposal', {
    cascadeRemove: [{ table: 'runPlanProposalLinks', foreignKey: 'planProposalId' }],
    orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    globalSnapshot: false,
    scope: { kind: 'conversationReverseVia', table: 'runPlanProposalLinks', localField: 'id', foreignField: 'planProposalId' }
  }),
  runPlanProposalLinks: upsertRemoveTable('runPlanProposalLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  toolPolicies: upsertRemoveTable('toolPolicy', 'toolPolicy'),
  toolPolicyScopeLinks: upsertRemoveTable('toolPolicyScopeLink', 'link'),
  builtinToolPolicies: upsertRemoveTable('builtinToolPolicy', 'toolPolicy'),
  skillDefinitions: upsertRemoveTable('skillDefinition', 'skillDefinition'),
  skillPolicies: upsertRemoveTable('skillPolicy', 'skillPolicy'),
  skillPolicyScopeLinks: upsertRemoveTable('skillPolicyScopeLink', 'link'),
  ruleFiles: upsertRemoveTable('ruleFile', 'ruleFile'),
  systemPrompts: upsertRemoveTable('systemPrompt', 'systemPrompt', { cascadeRemove: [{ table: 'systemPromptScopeLinks', foreignKey: 'systemPromptId' }, { table: 'runSystemPromptLinks', foreignKey: 'systemPromptId' }] }),
  systemPromptScopeLinks: upsertRemoveTable('systemPromptScopeLink', 'link', { globalSnapshot: true }),
  promptPlaceholders: upsertRemoveTable('promptPlaceholder', 'placeholder'),
  runtimeContexts: upsertRemoveTable('runtimeContext', 'runtimeContext', { cascadeRemove: [{ table: 'runtimeContextScopeLinks', foreignKey: 'runtimeContextId' }] }),
  runtimeContextScopeLinks: upsertRemoveTable('runtimeContextScopeLink', 'link', { globalSnapshot: true }),
  runtimeContextSnapshots: upsertRemoveTable('runtimeContextSnapshot', 'snapshot', {
    cascadeRemove: [{ table: 'conversationRuntimeContextSnapshotLinks', foreignKey: 'runtimeContextSnapshotId' }, { table: 'runRuntimeContextSnapshotLinks', foreignKey: 'runtimeContextSnapshotId' }],
    globalSnapshot: true,
    scope: { kind: 'conversation', field: 'conversationId', replace: 'upsertOnly' }
  }),
  conversationRuntimeContextSnapshotLinks: upsertRemoveTable('conversationRuntimeContextSnapshotLink', 'link', { scope: { kind: 'conversation', field: 'conversationId' }, globalSnapshot: true }),
  runRuntimeContextSnapshotLinks: upsertRemoveTable('runRuntimeContextSnapshotLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  modelProfiles: upsertRemoveTable('modelProfile', 'modelProfile', { cascadeRemove: [{ table: 'modelProfileScopeLinks', foreignKey: 'modelProfileId' }, { table: 'runModelProfileLinks', foreignKey: 'modelProfileId' }] }),
  modelProfileScopeLinks: upsertRemoveTable('modelProfileScopeLink', 'link', { globalSnapshot: true }),
  conversationWorkflowSelections: upsertRemoveTable('conversationWorkflowSelection', 'selection', { scope: { kind: 'conversation', field: 'conversationId' }, globalSnapshot: true }),
  conversations: upsertRemoveTable('conversation', 'conversation', {
    scope: { kind: 'conversation', field: 'id', replace: 'upsertOnly' },
    globalSnapshot: true,
    removeScope: { kind: 'conversation' },
    cascadeRemove: [
      { table: 'conversationReuseLinks', foreignKey: 'conversationId' },
      { table: 'conversationBranchLinks', foreignKeys: ['sourceConversationId', 'targetConversationId'] },
      { table: 'conversationOriginLinks', foreignKey: 'conversationId' },
      { table: 'agentConversationLinks', foreignKey: 'conversationId' },
      { table: 'conversationAgentSelections', foreignKey: 'conversationId' },
      { table: 'conversationWorkflowSelections', foreignKey: 'conversationId' },
      { table: 'conversationProjectLinks', foreignKey: 'conversationId' },
      { table: 'conversationWorkEnvironmentLinks', foreignKey: 'conversationId' },
      { table: 'conversationCheckpointRepositoryLinks', foreignKey: 'conversationId' },
      { table: 'checkpoints', foreignKey: 'conversationId' },
      { table: 'checkpointTimelineAnchors', foreignKey: 'conversationId' },
      { table: 'checkpointPolicyScopeLinks', foreignKey: 'scopeId' },
      { table: 'workEnvironmentPolicyScopeLinks', foreignKey: 'scopeId' },
      { table: 'systemPromptScopeLinks', foreignKey: 'scopeId' },
      { table: 'modelProfileScopeLinks', foreignKey: 'scopeId' },
      { table: 'runtimeContextScopeLinks', foreignKey: 'scopeId' },
      { table: 'planReviewPolicyScopeLinks', foreignKey: 'scopeId' },
      { table: 'conversationRuntimeContextSnapshotLinks', foreignKey: 'conversationId' },
      { table: 'turns', foreignKey: 'conversationId', cascade: true },
      { table: 'turnIntents', foreignKey: 'conversationId', cascade: true },
      { table: 'pendingTurnInputs', foreignKey: 'conversationId' },
      { table: 'executionLeases', foreignKey: 'conversationId' },
      { table: 'authoritySnapshots', foreignKey: 'conversationId' },
      { table: 'runtimeDeliveryLinks', foreignKey: 'destinationConversationId' },
      { table: 'interactionOwnerLinks', foreignKey: 'conversationId' },
      { table: 'messages', foreignKey: 'conversationId', cascade: true },
      { table: 'compressionBlocks', foreignKey: 'conversationId', cascade: true }
    ]
  }),
  conversationReuseLinks: upsertRemoveTable('conversationReuseLink', 'link', { scope: { kind: 'conversation', field: 'conversationId' }, globalSnapshot: true }),
  conversationBranchLinks: upsertRemoveTable('conversationBranchLink', 'link', { scope: { kind: 'conversationAny', fields: ['sourceConversationId', 'targetConversationId'] }, globalSnapshot: true }),
  conversationOriginLinks: upsertRemoveTable('conversationOriginLink', 'link', { scope: { kind: 'conversation', field: 'conversationId' }, globalSnapshot: true }),
  agentConversationLinks: upsertRemoveTable('agentConversationLink', 'link', { scope: { kind: 'conversation', field: 'conversationId', replace: 'removeOnly' }, globalSnapshot: true }),
  conversationAgentSelections: upsertRemoveTable('conversationAgentSelection', 'selection', { scope: { kind: 'conversation', field: 'conversationId' }, globalSnapshot: true }),
  projectContexts: upsertRemoveTable('projectContext', 'projectContext', {
    cascadeRemove: [
      { table: 'conversationProjectLinks', foreignKey: 'projectContextId' },
      { table: 'conversationCheckpointRepositoryLinks', foreignKey: 'projectContextId' },
      { table: 'checkpoints', foreignKey: 'projectContextId' }
    ],
    globalSnapshot: true,
    scope: {
      kind: 'conversationReverseVia',
      table: 'conversationProjectLinks',
      localField: 'id',
      foreignField: 'projectContextId',
      replace: 'upsertOnly'
    }
  }),
  conversationProjectLinks: upsertRemoveTable('conversationProjectLink', 'link', { scope: { kind: 'conversation', field: 'conversationId' }, globalSnapshot: true }),
  workEnvironments: upsertRemoveTable('workEnvironment', 'workEnvironment', {
    cascadeRemove: [
      { table: 'conversationWorkEnvironmentLinks', foreignKey: 'workEnvironmentId' },
      { table: 'runWorkEnvironmentLinks', foreignKey: 'workEnvironmentId' }
    ],
    globalSnapshot: true
  }),
  workEnvironmentPolicies: upsertRemoveTable('workEnvironmentPolicy', 'policy', {
    cascadeRemove: [
      { table: 'workEnvironmentPolicyScopeLinks', foreignKey: 'workEnvironmentPolicyId' }
    ],
    globalSnapshot: true
  }),
  workEnvironmentPolicyScopeLinks: upsertRemoveTable('workEnvironmentPolicyScopeLink', 'link', { globalSnapshot: true }),
  conversationWorkEnvironmentLinks: upsertRemoveTable('conversationWorkEnvironmentLink', 'link', { scope: { kind: 'conversation', field: 'conversationId' }, globalSnapshot: true }),
  runWorkEnvironmentLinks: upsertRemoveTable('runWorkEnvironmentLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  checkpointPolicies: upsertRemoveTable('checkpointPolicy', 'policy', {
    cascadeRemove: [{ table: 'checkpointPolicyScopeLinks', foreignKey: 'checkpointPolicyId' }],
    globalSnapshot: true
  }),
  checkpointPolicyScopeLinks: upsertRemoveTable('checkpointPolicyScopeLink', 'link', { globalSnapshot: true }),
  shadowRepositories: upsertRemoveTable('shadowRepository', 'shadowRepository', {
    cascadeRemove: [
      { table: 'conversationCheckpointRepositoryLinks', foreignKey: 'shadowRepositoryId' },
      { table: 'checkpoints', foreignKey: 'shadowRepositoryId' }
    ],
    globalSnapshot: true
  }),
  conversationCheckpointRepositoryLinks: upsertRemoveTable('conversationCheckpointRepositoryLink', 'link', { scope: { kind: 'conversation', field: 'conversationId' }, globalSnapshot: true }),
  checkpoints: upsertRemoveTable('checkpoint', 'checkpoint', {
    cascadeRemove: [{ table: 'checkpointTimelineAnchors', foreignKey: 'checkpointId' }],
    orderBy: [{ field: 'createdAt', direction: 'desc' }, { field: 'id' }],
    globalSnapshot: true,
    scope: { kind: 'conversation', field: 'conversationId' }
  }),
  checkpointTimelineAnchors: upsertRemoveTable('checkpointTimelineAnchor', 'anchor', {
    orderBy: [{ field: 'order' }, { field: 'createdAt' }, { field: 'id' }],
    globalSnapshot: true,
    scope: { kind: 'conversation', field: 'conversationId' }
  }),
  messages: {
    patch: {
      upsert: { kind: 'message.upsert', payloadField: 'message' },
      remove: { kind: 'message.remove' }
    },
    clientSync: messageTable
  },
  messageRevisions: upsertRemoveTable('messageRevision', 'revision', { ...conversationScopedTable, orderBy: [{ field: 'createdAt' }, { field: 'id' }] }),
  messageCurrentRevisionLinks: upsertRemoveTable('messageCurrentRevisionLink', 'link', { ...conversationScopedTable, scope: { kind: 'conversationVia', table: 'messages', localField: 'messageId', foreignField: 'id' } }),
  modelContextProjections: upsertRemoveTable('modelContextProjection', 'projection', {
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    cascadeRemove: [
      { table: 'modelContextProjectionSourceLinks', foreignKey: 'projectionId' },
      { table: 'requestModelContextProjectionLinks', foreignKey: 'projectionId' },
      { table: 'compressionModelContextProjectionLinks', foreignKey: 'projectionId' }
    ]
  }),
  modelContextProjectionSourceLinks: upsertRemoveTable('modelContextProjectionSourceLink', 'link', {
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'order' }, { field: 'id' }]
  }),
  requestModelContextProjectionLinks: upsertRemoveTable('requestModelContextProjectionLink', 'link', {
    scope: { kind: 'conversationVia', table: 'modelContextProjections', localField: 'projectionId', foreignField: 'id' },
    globalSnapshot: false
  }),
  compressionModelContextProjectionLinks: upsertRemoveTable('compressionModelContextProjectionLink', 'link', {
    scope: { kind: 'conversationVia', table: 'compressionBlocks', localField: 'blockId', foreignField: 'id' },
    globalSnapshot: false
  }),
  compressionBlocks: upsertRemoveTable('compressionBlock', 'block', {
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'anchorSeq' }, { field: 'createdAt' }, { field: 'id' }],
    cascadeRemove: [
      { table: 'compressionBlockSourceLinks', foreignKey: 'blockId' },
      { table: 'compressionContextVariants', foreignKey: 'blockId' },
      { table: 'runCompressionBlockLinks', foreignKey: 'blockId' },
      { table: 'compressionBlockLlmInvocationLinks', foreignKey: 'blockId' },
      { table: 'compressionModelContextProjectionLinks', foreignKey: 'blockId' }
    ]
  }),
  compressionBlockSourceLinks: upsertRemoveTable('compressionBlockSourceLink', 'link', {
    scope: { kind: 'conversationVia', table: 'compressionBlocks', localField: 'blockId', foreignField: 'id' },
    globalSnapshot: false,
    orderBy: [{ field: 'order' }, { field: 'id' }]
  }),
  compressionContextVariants: upsertRemoveTable('compressionContextVariant', 'variant', {
    scope: { kind: 'conversationVia', table: 'compressionBlocks', localField: 'blockId', foreignField: 'id' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  runCompressionBlockLinks: upsertRemoveTable('runCompressionBlockLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  compressionBlockLlmInvocationLinks: upsertRemoveTable('compressionBlockLlmInvocationLink', 'link', { scope: { kind: 'conversationVia', table: 'compressionBlocks', localField: 'blockId', foreignField: 'id' } }),
  llmInvocations: upsertRemoveTable('llmInvocation', 'invocation', {
    cascadeRemove: [
      { table: 'runLlmInvocationLinks', foreignKey: 'invocationId' },
      { table: 'messageLlmInvocationLinks', foreignKey: 'invocationId' },
      { table: 'compressionBlockLlmInvocationLinks', foreignKey: 'invocationId' }
    ],
    orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    scope: {
      kind: 'conversationAnyOf',
      scopes: [
        { kind: 'conversationReverseVia', table: 'runLlmInvocationLinks', localField: 'id', foreignField: 'invocationId' },
        { kind: 'conversationReverseVia', table: 'messageLlmInvocationLinks', localField: 'id', foreignField: 'invocationId' },
        { kind: 'conversationReverseVia', table: 'compressionBlockLlmInvocationLinks', localField: 'id', foreignField: 'invocationId' }
      ]
    }
  }),
  runLlmInvocationLinks: upsertRemoveTable('runLlmInvocationLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  messageLlmInvocationLinks: upsertRemoveTable('messageLlmInvocationLink', 'link', { scope: { kind: 'conversationVia', table: 'messages', localField: 'messageId', foreignField: 'id' } }),
  toolCalls: upsertRemoveTable('toolcall', 'toolCall', toolCallsTable),
  toolCallPreviews: upsertRemoveTable('toolCallPreview', 'preview', {
    cascadeRemove: [{ table: 'toolCallPreviewTargetLinks', foreignKey: 'previewId' }],
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    scope: { kind: 'conversationReverseVia', table: 'toolCallPreviewTargetLinks', localField: 'id', foreignField: 'previewId' }
  }),
  toolCallPreviewTargetLinks: upsertRemoveTable('toolCallPreviewTargetLink', 'link', {
    globalSnapshot: false,
    scope: { kind: 'conversation', field: 'conversationId' }
  }),
  toolCallEvents: appendRemoveTable('toolcallEvent', 'event', toolCallEventsTable),
  toolResultArtifacts: upsertRemoveTable('toolResultArtifact', 'artifact', {
    cascadeRemove: [{ table: 'toolCallResultLinks', foreignKey: 'artifactId' }],
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  toolCallResultLinks: upsertRemoveTable('toolCallResultLink', 'link', {
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  interactionRequests: upsertRemoveTable('interactionRequest', 'request', {
    scope: {
      kind: 'conversationReverseVia',
      table: 'interactionOwnerLinks',
      localField: 'id',
      foreignField: 'interactionRequestId'
    },
    cascadeRemove: [
      { table: 'interactionOwnerLinks', foreignKey: 'interactionRequestId' },
      { table: 'interactionResponses', foreignKey: 'interactionRequestId' }
    ],
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  interactionOwnerLinks: upsertRemoveTable('interactionOwnerLink', 'link', {
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  interactionResponses: upsertRemoveTable('interactionResponse', 'response', {
    scope: { kind: 'conversationVia', table: 'interactionOwnerLinks', localField: 'interactionRequestId', foreignField: 'interactionRequestId' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  backgroundProcesses: upsertRemoveTable('backgroundProcess', 'process', {
    cascadeRemove: [{ table: 'backgroundProcessOriginLinks', foreignKey: 'backgroundProcessId' }],
    scope: {
      kind: 'conversationReverseVia',
      table: 'backgroundProcessOriginLinks',
      localField: 'id',
      foreignField: 'backgroundProcessId',
      replace: 'upsertOnly'
    },
    globalSnapshot: true,
    orderBy: [{ field: 'startedAt', direction: 'desc' }, { field: 'id' }]
  }),
  backgroundProcessOriginLinks: upsertRemoveTable('backgroundProcessOriginLink', 'link', {
    scope: { kind: 'conversation', field: 'conversationId', replace: 'upsertOnly' },
    globalSnapshot: true
  }),
  turns: upsertRemoveTable('turn', 'turn', {
    scope: { kind: 'conversation', field: 'conversationId' },
    cascadeRemove: [
      { table: 'interactionOwnerLinks', foreignKey: 'turnId' },
      { table: 'interactionResponses', foreignKey: 'ownerTurnId' },
      { table: 'executionLeases', foreignKey: 'turnId' },
      { table: 'authoritySnapshots', foreignKey: 'turnId' },
      { table: 'messageTurnLinks', foreignKey: 'turnId' }
    ],
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  turnIntents: upsertRemoveTable('turnIntent', 'intent', {
    scope: { kind: 'conversation', field: 'conversationId' },
    cascadeRemove: [{ table: 'turnIntentRevisions', foreignKey: 'turnIntentId' }],
    globalSnapshot: false,
    orderBy: [{ field: 'order' }, { field: 'createdAt' }, { field: 'id' }]
  }),
  turnIntentRevisions: upsertRemoveTable('turnIntentRevision', 'revision', {
    scope: { kind: 'conversationVia', table: 'turnIntents', localField: 'turnIntentId', foreignField: 'id' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  pendingTurnInputs: upsertRemoveTable('pendingTurnInput', 'input', {
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  executionLeases: upsertRemoveTable('executionLease', 'lease', {
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false
  }),
  authoritySnapshots: upsertRemoveTable('authoritySnapshot', 'snapshot', {
    scope: { kind: 'conversation', field: 'conversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  runtimeDeliveryLinks: upsertRemoveTable('runtimeDeliveryLink', 'link', {
    scope: { kind: 'conversation', field: 'destinationConversationId' },
    globalSnapshot: false,
    orderBy: [{ field: 'createdAt' }, { field: 'id' }]
  }),
  agentRuns: upsertRemoveTable('agentRun', 'run', agentRunsTable),
  runTerminations: upsertRemoveTable('runTermination', 'termination', {
    orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' }
  }),
  agentRunSourceLinks: upsertRemoveTable('agentRunSourceLink', 'link', { scope: { kind: 'conversationAnyOf', scopes: [{ kind: 'conversation', field: 'sourceConversationId' }, { kind: 'conversationVia', table: 'messages', localField: 'sourceMessageId', foreignField: 'id' }, { kind: 'conversationVia', table: 'toolCalls', localField: 'sourceToolCallId', foreignField: 'id' }, { kind: 'conversationVia', table: 'agentRuns', localField: 'sourceRunId', foreignField: 'id' }, { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' }] } }),
  agentRunTargetLinks: upsertRemoveTable('agentRunTargetLink', 'link', { scope: { kind: 'conversationAnyOf', scopes: [{ kind: 'conversation', field: 'conversationId' }, { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' }] } }),
  messageTurnLinks: upsertRemoveTable('messageTurnLink', 'link', { scope: { kind: 'conversationAnyOf', scopes: [{ kind: 'conversationVia', table: 'messages', localField: 'messageId', foreignField: 'id' }, { kind: 'conversationVia', table: 'turns', localField: 'turnId', foreignField: 'id' }] } }),
  toolCallRunLinks: upsertRemoveTable('toolCallRunLink', 'link', { scope: { kind: 'conversationAnyOf', scopes: [{ kind: 'conversationVia', table: 'toolCalls', localField: 'toolCallId', foreignField: 'id' }, { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' }] } }),
  runConversationPolicies: upsertRemoveTable('runConversationPolicy', 'policy', { scope: { kind: 'conversationReverseVia', table: 'runConversationPolicyLinks', localField: 'id', foreignField: 'policyId', replace: 'upsertOnly' } }),
  runContextPolicies: upsertRemoveTable('runContextPolicy', 'policy', { scope: { kind: 'conversationReverseVia', table: 'runContextPolicyLinks', localField: 'id', foreignField: 'policyId', replace: 'upsertOnly' } }),
  runDeliveryPolicies: upsertRemoveTable('runDeliveryPolicy', 'policy', { scope: { kind: 'conversationReverseVia', table: 'runDeliveryPolicyLinks', localField: 'id', foreignField: 'policyId', replace: 'upsertOnly' } }),
  runEditPolicies: upsertRemoveTable('runEditPolicy', 'policy', { scope: { kind: 'conversationReverseVia', table: 'runEditPolicyLinks', localField: 'id', foreignField: 'policyId', replace: 'upsertOnly' } }),
  runWorkflowLinks: upsertRemoveTable('runWorkflowLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  runSystemPromptLinks: upsertRemoveTable('runSystemPromptLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  runModelProfileLinks: upsertRemoveTable('runModelProfileLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  runToolPolicyLinks: upsertRemoveTable('runToolPolicyLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  runConversationPolicyLinks: upsertRemoveTable('runConversationPolicyLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  runContextPolicyLinks: upsertRemoveTable('runContextPolicyLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  runDeliveryPolicyLinks: upsertRemoveTable('runDeliveryPolicyLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  runEditPolicyLinks: upsertRemoveTable('runEditPolicyLink', 'link', { scope: { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' } }),
  agentRunInputRevisions: upsertRemoveTable('agentRunInputRevision', 'inputRevision', { scope: { kind: 'conversationAnyOf', scopes: [{ kind: 'conversation', field: 'conversationId' }, { kind: 'conversationVia', table: 'agentRuns', localField: 'runId', foreignField: 'id' }] } }),
  agentAnswers: upsertRemoveTable('agentAnswer', 'answer', {
    cascadeRemove: [{ table: 'agentAnswerSubmissionLinks', foreignKey: 'answerId' }, { table: 'agentAnswerTargetLinks', foreignKey: 'answerId' }],
    globalSnapshot: true
  }),
  agentAnswerSubmissionLinks: upsertRemoveTable('agentAnswerSubmissionLink', 'link', { globalSnapshot: true }),
  agentAnswerTargetLinks: upsertRemoveTable('agentAnswerTargetLink', 'link', { globalSnapshot: true })
} as const satisfies ClientStateTableRegistry;

export const CLIENT_STATE_TABLE_KEYS = Object.keys(CLIENT_STATE_TABLES) as ClientStateTableKey[];

export const GLOBAL_CLIENT_STATE_TABLE_KEYS = CLIENT_STATE_TABLE_KEYS.filter((key) => CLIENT_STATE_TABLES[key].clientSync.globalSnapshot);

export const GENERIC_CLIENT_STATE_DIFF_TABLE_KEYS = CLIENT_STATE_TABLE_KEYS.filter((key) => CLIENT_STATE_TABLES[key].clientSync.diff === 'generic');

export interface GenericClientPatchApplyOperation {
  readonly tableKey: ClientStateTableKey;
  readonly operation: ClientStatePatchOperation;
  readonly payloadField?: string;
}

export interface GenericClientMutationApplyOperation {
  readonly tableKey: ClientStateTableKey;
  readonly apply: ClientStateMutationApplySpec;
}

export const GENERIC_CLIENT_PATCH_APPLY_BY_KIND: Readonly<Record<string, GenericClientPatchApplyOperation>> = createGenericClientPatchApplyByKind();
export const GENERIC_CLIENT_MUTATION_APPLY_BY_KIND: Readonly<Record<string, GenericClientMutationApplyOperation>> = createGenericClientMutationApplyByKind();

export function createEmptyClientState(): ClientState {
  const state: Partial<Record<ClientStateTableKey, unknown[]>> = {};
  for (const key of CLIENT_STATE_TABLE_KEYS) state[key] = [];
  return state as ClientState;
}

export function copyClientStateTables<TTarget extends ClientState>(
  target: TTarget,
  source: ClientState,
  keys: readonly ClientStateTableKey[]
): TTarget {
  const writableTarget = target as unknown as Record<ClientStateTableKey, unknown>;
  const readableSource = source as unknown as Record<ClientStateTableKey, unknown>;
  for (const key of keys) writableTarget[key] = readableSource[key];
  return target;
}

export function clientStateWithTables(source: ClientState, keys: readonly ClientStateTableKey[]): ClientState {
  return copyClientStateTables(createEmptyClientState(), source, keys);
}

function createGenericClientPatchApplyByKind(): Readonly<Record<string, GenericClientPatchApplyOperation>> {
  const operations: Record<string, GenericClientPatchApplyOperation> = {};
  for (const tableKey of CLIENT_STATE_TABLE_KEYS) {
    const spec = CLIENT_STATE_TABLES[tableKey];
    const patch = spec.patch as ClientStateTablePatchSpec;
    const apply = spec.clientSync.apply as Readonly<Partial<Record<ClientStatePatchOperation, ClientStatePatchMode>>>;
    if (patch.upsert && apply.upsert === 'generic') {
      operations[patch.upsert.kind] = { tableKey, operation: 'upsert', payloadField: patch.upsert.payloadField };
    }
    if (patch.append && apply.append === 'generic') {
      operations[patch.append.kind] = { tableKey, operation: 'append', payloadField: patch.append.payloadField };
    }
    if (patch.remove && apply.remove === 'generic') {
      operations[patch.remove.kind] = { tableKey, operation: 'remove' };
    }
  }
  return operations;
}

function createGenericClientMutationApplyByKind(): Readonly<Record<string, GenericClientMutationApplyOperation>> {
  const operations: Record<string, GenericClientMutationApplyOperation> = {};
  for (const tableKey of CLIENT_STATE_TABLE_KEYS) {
    for (const mutationSpec of CLIENT_STATE_TABLES[tableKey].clientSync.mutations ?? []) {
      operations[mutationSpec.kind] = { tableKey, apply: mutationSpec.apply };
    }
  }
  return operations;
}

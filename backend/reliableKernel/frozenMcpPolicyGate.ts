import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { toolArtifactIdentifiesCall } from './copiedToolIdentity';
import { readFrozenTurnAuthority } from './frozenAuthority';
import type { McpAuthorizationRequest, McpExistingPolicyGate } from './mcpEffects';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';
import { contextRootContainsCompleteToolPair } from './turnControlPlane';
import { toolAllowedByPolicy } from '../../shared/toolPolicyResolution';

export type FrozenPlanReviewRiskLevel = 'read' | 'write' | 'command' | 'agent';

export async function authorizeFrozenPlanReview(input: {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  authorityDocument: PlainJsonValue;
  turnId: string;
  beforeCallSeq: bigint;
  riskLevel: FrozenPlanReviewRiskLevel;
}): Promise<{ allowed: boolean; reason?: string }> {
  const authority = requireRecord(input.authorityDocument, 'AuthoritySnapshot');
  const planPolicy = requireRecord(authority.planReviewPolicy, 'AuthoritySnapshot.planReviewPolicy');
  if (planPolicy.mode !== 'before_mutation') return { allowed: true };
  if (input.riskLevel === 'read' && planPolicy.allowReadonlyBeforeApproval === true) return { allowed: true };
  const required = Array.isArray(planPolicy.requireForToolRiskLevels)
    ? planPolicy.requireForToolRiskLevels
    : [];
  if (input.riskLevel !== 'read' && !required.includes(input.riskLevel)) return { allowed: true };
  const approved = await hasApprovedPlanBeforeCall(
    input.database,
    input.contentStore,
    authority,
    requireId(input.turnId, 'turnId'),
    input.beforeCallSeq
  );
  if (input.riskLevel === 'read') {
    return approved
      ? { allowed: true }
      : { allowed: false, reason: '冻结 PlanReviewPolicy 要求只读工具也必须等待已批准的 Plan。' };
  }
  return approved
    ? { allowed: true }
    : { allowed: false, reason: '冻结 PlanReviewPolicy 要求先提交并批准 Plan。' };
}

/** Evaluates MCP authorization only from the ToolCall's frozen Turn authority and durable plan facts. */
export class FrozenAuthorityMcpPolicyGate implements McpExistingPolicyGate {
  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore
  ) {}

  public async authorize(request: McpAuthorizationRequest): Promise<{
    toolPolicyAllowed: boolean;
    planReviewAllowed: boolean;
    reason?: string;
  }> {
    const toolCall = await this.requireExisting('ToolCall', request.toolCallId);
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const snapshots = await this.list('AuthoritySnapshot', { turn_id: turnId }, 2);
    if (snapshots.length !== 1) throw new Error(`Turn ${turnId} must have exactly one AuthoritySnapshot.`);
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      requireId(snapshots[0].id, 'AuthoritySnapshot.id'),
      turnId
    );
    const authority = requireRecord(frozen.document, 'AuthoritySnapshot');
    const toolPolicy = requireRecord(authority.toolPolicy, 'AuthoritySnapshot.toolPolicy');
    const allowed = mcpToolAllowed(toolPolicy, {
      displayName: String(toolCall.tool_name),
      serverId: request.serverId
    });
    if (!allowed) {
      return {
        toolPolicyAllowed: false,
        planReviewAllowed: false,
        reason: `冻结 ToolPolicy 不允许 MCP 工具 ${String(toolCall.tool_name)}。`
      };
    }

    const plan = await authorizeFrozenPlanReview({
      database: this.database,
      contentStore: this.contentStore,
      authorityDocument: authority,
      turnId,
      beforeCallSeq: requireBigInt(toolCall.call_seq, 'ToolCall.call_seq'),
      riskLevel: request.riskLevel
    });
    return plan.allowed
      ? { toolPolicyAllowed: true, planReviewAllowed: true }
      : {
          toolPolicyAllowed: true,
          planReviewAllowed: false,
          ...(plan.reason ? { reason: plan.reason } : {})
        };
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }
}

async function hasApprovedPlanBeforeCall(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  authority: { [key: string]: PlainJsonValue },
  turnId: string,
  beforeCallSeq: bigint
): Promise<boolean> {
  const calls = (await listAllDomainRows(database, 'ToolCall', { turn_id: turnId }))
    .filter((call) => call.tool_name === 'submit_plan' && requireBigInt(call.call_seq, 'ToolCall.call_seq') < beforeCallSeq);
  for (const call of calls) {
    if (await isApprovedPlanResult(database, contentStore, call)) return true;
  }
  const lineage = optionalRecord(authority.retryLineage);
  const inheritedToolCallId = optionalId(lineage?.inheritedPlanApprovalToolCallId);
  const sourceTurnId = optionalId(lineage?.sourceTurnId);
  if (!inheritedToolCallId || !sourceTurnId) return false;
  if (!optionalId(lineage?.sourceMessageId) && !optionalId(lineage?.sourceModelRequestId)) return false;
  const inheritedCall = await requireExistingRow(database, 'ToolCall', inheritedToolCallId);
  if (inheritedCall.turn_id !== sourceTurnId || inheritedCall.tool_name !== 'submit_plan') return false;
  if (!await isApprovedPlanResult(database, contentStore, inheritedCall)) return false;

  const currentCalls = await listAllDomainRows(database, 'ToolCall', { turn_id: turnId });
  const currentCall = currentCalls.find((call) =>
    requireBigInt(call.call_seq, 'ToolCall.call_seq') === beforeCallSeq
  );
  if (!currentCall) return false;
  const sourceLinks = await listRows(database, 'ToolCallSourceLink', {
    tool_call_id: requireId(currentCall.id, 'ToolCall.id')
  }, 2);
  if (sourceLinks.length !== 1) return false;
  const projections = await listRows(database, 'ModelContextProjection', {
    owner_kind: 'model_request',
    owner_id: requireId(sourceLinks[0].model_request_id, 'ToolCallSourceLink.model_request_id')
  }, 2);
  if (projections.length !== 1) return false;
  return contextRootContainsCompleteToolPair(
    database,
    requireId(projections[0].root_id, 'ModelContextProjection.root_id'),
    inheritedToolCallId
  );
}

async function isApprovedPlanResult(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  call: DomainRow
): Promise<boolean> {
  const toolCallId = requireId(call.id, 'ToolCall.id');
  const outcomes = await listRows(database, 'ToolOutcome', { tool_call_id: toolCallId }, 2);
  if (outcomes.length !== 1 || outcomes[0].status !== 'succeeded') return false;
  const artifacts = await listRows(database, 'ToolResultArtifact', {
    tool_call_id: toolCallId,
    role: 'no_effect_result'
  }, 2);
  if (artifacts.length !== 1) return false;
  const content = await requireExistingRow(
    database,
    'ContentObject',
    requireId(artifacts[0].content_object_id, 'ToolResultArtifact.content_object_id')
  ) as unknown as ContentObjectMetadata;
  const body = requireUnknownRecord(
    JSON.parse((await contentStore.read(content)).toString('utf8')),
    'submit_plan result artifact'
  );
  const detail = requireUnknownRecord(body.detail, 'submit_plan result artifact.detail');
  // A fork copies the ToolCall but shares the artifact content naming the original call.
  return body.status === 'succeeded'
    && detail.status === 'approved'
    && await toolArtifactIdentifiesCall(database, body.toolCallId, call);
}

async function requireExistingRow(database: RuntimeDatabase, domain: string, id: string): Promise<DomainRow> {
  const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  const row = snapshot.snapshot[0];
  if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
  return row;
}

async function listRows(
  database: RuntimeDatabase,
  domain: string,
  where: DomainRow,
  limit: number
): Promise<DomainRow[]> {
  const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
  const rows = snapshot.snapshot[0];
  if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
  return rows;
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireUnknownRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function optionalRecord(value: PlainJsonValue | undefined): { [key: string]: PlainJsonValue } | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function optionalId(value: PlainJsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mcpToolAllowed(
  policy: { [key: string]: PlainJsonValue },
  tool: { displayName: string; serverId: string }
): boolean {
  const allowedTools = Array.isArray(policy.allowedTools)
    ? policy.allowedTools.filter((name): name is string => typeof name === 'string')
    : [];
  return toolAllowedByPolicy({ allowedTools, sourceConfigs: policy.sourceConfigs }, {
    name: tool.displayName,
    source: { kind: 'mcp', sourceId: tool.serverId }
  });
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must remain a non-negative bigint.`);
  return value;
}

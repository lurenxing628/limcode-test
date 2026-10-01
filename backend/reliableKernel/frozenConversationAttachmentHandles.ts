import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { toolArtifactIdentifiesCall } from './copiedToolIdentity';
import { isPersistentContextHandle, normalizeModelHandleCatalog,
  type ModelHandleEntry } from './modelHandleCatalog';
import { normalizePlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';

const NATIVE_PROJECTION_KIND = 'native_child_handle_projection';
const NATIVE_PROJECTION_CONTENT_TYPE = 'application/vnd.limcode.native-child-handle-projection+json';
const RECIPE_CONTENT_TYPE = 'application/vnd.limcode.model-request-recipe+json';

export interface FrozenConversationAttachmentReservations {
  entries: ModelHandleEntry[];
  attachments: Map<string, DomainRow>;
  assertions: RepositoryTransactionStep[];
  createdAt?: string;
}

/**
 * Published forks copied immutable recipes but trimmed the attachment address registry with the
 * visible transcript. Only these known fork producers need reconstruction. Every recovered F#
 * comes from the target's actual frozen evidence; no source Conversation or prose is consulted.
 */
export async function readFrozenConversationAttachmentReservations(database: RuntimeDatabase,
  contentStore: ContentAddressedStore, conversationId: string): Promise<FrozenConversationAttachmentReservations> {
  const branches = await listAllDomainRows(database, 'ConversationBranchLink', { target_conversation_id: conversationId });
  if (branches.length === 0) return { entries: [], attachments: new Map(), assertions: [] };
  if (branches.length !== 1) throw frozenAttachmentError('Attachment reservation fork ownership is not unique.');
  const assertions: RepositoryTransactionStep[] = [DOMAIN_REPOSITORIES.domain('ConversationBranchLink').assert(
    id(branches[0].id), { target_conversation_id: conversationId, source_conversation_id: branches[0].source_conversation_id })];
  const turns = await listAllDomainRows(database, 'Turn', { conversation_id: conversationId });
  assertions.push(DOMAIN_REPOSITORIES.domain('Turn').assertExactIds({ conversation_id: conversationId }, turns.map(turn => id(turn.id))));
  const uniqueFacts = new Map<string, ModelHandleEntry>();
  const addFact = (entry: ModelHandleEntry) => uniqueFacts.set(JSON.stringify(entry), entry);
  const recipeCache = new Map<string, ModelHandleEntry[]>();
  for (const turn of turns) {
    const turnId = id(turn.id);
    assertions.push(DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { conversation_id: conversationId }));
    const requests = await listAllDomainRows(database, 'ModelRequest', { turn_id: turnId });
    assertions.push(DOMAIN_REPOSITORIES.domain('ModelRequest').assertExactIds({ turn_id: turnId }, requests.map(request => id(request.id))));
    for (const request of requests) {
      const requestId = id(request.id);
      const recipeId = id(request.recipe_object_id);
      assertions.push(DOMAIN_REPOSITORIES.domain('ModelRequest').assert(requestId, { turn_id: turnId, recipe_object_id: recipeId }));
      let frozen = recipeCache.get(recipeId);
      if (frozen === undefined) {
        const recipe = await readFrozenObject(database, contentStore, recipeId, RECIPE_CONTENT_TYPE);
        frozen = normalizeModelHandleCatalog(recipe.modelHandleCatalog).entries.filter(entry => entry.kind === 'attachment');
        recipeCache.set(recipeId, frozen);
        if (recipeCache.size > 64) recipeCache.delete(recipeCache.keys().next().value!);
      }
      for (const entry of frozen) addFact(entry);
      const byRef = new Map(frozen.map(entry => [entry.ref, entry.target]));
      const sources = await listAllDomainRows(database, 'ToolCallSourceLink', { model_request_id: requestId });
      assertions.push(DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').assertExactIds({ model_request_id: requestId }, sources.map(source => id(source.id))));
      for (const source of sources) {
        const toolCallId = id(source.tool_call_id);
        assertions.push(DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').assert(id(source.id), { model_request_id: requestId, tool_call_id: toolCallId }));
        const where = { tool_call_id: toolCallId, event_kind: NATIVE_PROJECTION_KIND };
        const events = await listAllDomainRows(database, 'ToolCallEvent', where);
        assertions.push(DOMAIN_REPOSITORIES.domain('ToolCallEvent').assertExactIds(where, events.map(event => id(event.id))));
        if (events.length === 0) continue;
        const callSnapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('ToolCall').get(toolCallId)]);
        const call = row(callSnapshot.snapshot[0], 'Native attachment ToolCall');
        if (call.turn_id !== turnId) throw frozenAttachmentError('Native attachment evidence belongs to another Turn.');
        for (const event of events) {
          assertions.push(DOMAIN_REPOSITORIES.domain('ToolCallEvent').assert(id(event.id), { ...where, content_object_id: event.content_object_id }));
          const projection = await readFrozenObject(database, contentStore, id(event.content_object_id), NATIVE_PROJECTION_CONTENT_TYPE);
          if (projection.kind !== NATIVE_PROJECTION_KIND || !await toolArtifactIdentifiesCall(database, projection.toolCallId, call)) {
            throw frozenAttachmentError('Native attachment projection has no proved carrier ToolCall.');
          }
          const hasCatalog = 'modelHandleCatalog' in projection;
          const catalog = normalizeModelHandleCatalog(hasCatalog ? projection.modelHandleCatalog : { entries: projection.childHandles });
          if (!hasCatalog && catalog.entries.some(entry => !isPersistentContextHandle(entry.kind))) {
            throw frozenAttachmentError('Legacy native child projection contains an attachment address.');
          }
          for (const entry of catalog.entries) {
            if (entry.kind !== 'attachment') continue;
            if (byRef.get(entry.ref) !== entry.target) throw frozenAttachmentError(`Native attachment reference ${entry.ref} is not frozen in its initial request.`);
            addFact(entry);
          }
        }
      }
    }
  }
  // F is never retired or renumbered: even a valid-looking pair of old scopes must agree exactly.
  const byRef = new Map<string, ModelHandleEntry>();
  const byTarget = new Map<string, ModelHandleEntry>();
  for (const entry of uniqueFacts.values()) {
    const ref = byRef.get(entry.ref);
    const target = byTarget.get(entry.target);
    if ((ref && ref.target !== entry.target) || (target && target.ref !== entry.ref)) {
      throw frozenAttachmentError(`Conflicting frozen attachment reference ${entry.ref}.`);
    }
    if (!ref) byRef.set(entry.ref, entry);
    if (!target) byTarget.set(entry.target, entry);
  }
  const entries = [...byRef.values()];
  const attachments = new Map<string, DomainRow>();
  if (entries.length > 0) {
    const snapshot = await database.snapshot(entries.map(entry => DOMAIN_REPOSITORIES.domain('Attachment').get(entry.target)));
    for (const [index, entry] of entries.entries()) {
      const attachment = row(snapshot.snapshot[index], `Frozen Attachment ${entry.target}`);
      if (attachment.id !== entry.target) throw frozenAttachmentError('Frozen attachment identity is not its canonical target.');
      attachments.set(entry.target, attachment);
    }
  }
  for (const fact of uniqueFacts.values()) {
    const attachment = attachments.get(fact.target)!;
    if ((fact.name !== undefined && fact.name !== attachment.name)
      || (fact.mimeType !== undefined && fact.mimeType !== attachment.mime_type)
      || (fact.sizeBytes !== undefined && BigInt(fact.sizeBytes) !== BigInt(String(attachment.byte_length)))) {
      throw frozenAttachmentError(`Frozen Attachment ${fact.target} has conflicting immutable metadata.`);
    }
  }
  return { entries, attachments, assertions, createdAt: id(branches[0].created_at) };
}

async function readFrozenObject(database: RuntimeDatabase, contentStore: ContentAddressedStore,
  objectId: string, expectedContentType?: string): Promise<Record<string, unknown>> {
  const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(objectId)]);
  const metadata = row(snapshot.snapshot[0], `Frozen attachment CAS ${objectId}`);
  if (expectedContentType && metadata.content_type !== expectedContentType) throw frozenAttachmentError('Frozen attachment CAS type is invalid.');
  const value = normalizePlainJson(JSON.parse((await contentStore.read(metadata as unknown as ContentObjectMetadata)).toString('utf8')),
    'Frozen attachment identity evidence');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw frozenAttachmentError('Frozen attachment identity evidence is not an object.');
  return value;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw frozenAttachmentError('Frozen attachment identity is missing.');
  return value.trim();
}

function row(value: DomainRow | DomainRow[] | null, label: string): DomainRow {
  if (!value || Array.isArray(value)) throw frozenAttachmentError(`${label} is missing.`);
  return value;
}

export function frozenAttachmentError(message: string): Error {
  return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT' });
}

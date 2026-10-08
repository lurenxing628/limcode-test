import type { ContentAddressedStore } from './contentAddressedStore';
import { readFrozenTurnAuthority } from './frozenAuthority';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

/** The template rendered once for the selected conversation branch, before fresh rules are added. */
export interface FrozenInitialRuntimeContext {
  id: string | null;
  name: string;
  template: string;
  text: string;
}

export function frozenInitialRuntimeContext(document: PlainJsonValue): FrozenInitialRuntimeContext | undefined {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('Initial Runtime Context authority must be an object.');
  }
  const context = document.runtimeContext;
  if (context === undefined) return undefined;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('Initial Runtime Context must be an object.');
  }
  // Published authorities carry no independent initial-template fact. Their immutable bytes stay
  // untouched; the next new Turn establishes this fact once from the then-current template.
  if (context.renderedTemplateText === undefined) return undefined;
  if ((context.id !== null && typeof context.id !== 'string') || typeof context.name !== 'string'
    || typeof context.template !== 'string' || typeof context.renderedTemplateText !== 'string') {
    throw new TypeError('Frozen initial Runtime Context has invalid fields.');
  }
  return { id: context.id, name: context.name, template: context.template, text: context.renderedTemplateText };
}

export async function readInitialRuntimeContextForTurn(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnId: string,
  expectedConversationId: string,
  requireOwnConversation = false
): Promise<FrozenInitialRuntimeContext | undefined> {
  const snapshot = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: turnId }, limit: 2 })
  ]);
  const rows = snapshot.snapshot[0];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Turn ${turnId} must have exactly one initial Runtime Context authority.`);
  }
  const frozen = await readFrozenTurnAuthority(database, contentStore, String(rows[0]!.id), turnId);
  if (frozen.conversationId !== expectedConversationId) {
    throw new Error('Initial Runtime Context source Turn belongs to another Conversation.');
  }
  const initial = frozenInitialRuntimeContext(frozen.document);
  if (requireOwnConversation && initial && frozen.document && typeof frozen.document === 'object'
    && !Array.isArray(frozen.document) && frozen.document.conversationId !== expectedConversationId) {
    // A child may carry copied parent Turns. Their rows belong to the child but their immutable
    // authority bytes still identify the parent; they do not establish the child's initial state.
    return undefined;
  }
  return initial;
}

import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { modelHandleRef, type ModelHandleCatalog } from './modelHandleCatalog';
import { DOMAIN_REPOSITORIES } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

const CARD_PROCESS_LIMIT = 32;
const COMMAND_METADATA_MAX_BYTES = 64 * 1024;

/** A repaired P# is a new address, never a guess about what an ambiguous old P# meant.
 * Only this Conversation's proven process sources are described; a fork does not gain its
 * source's processes. This reads facts without starting, observing or stopping a process.
 */
export async function historicalProcessHandleCard(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string,
  catalog: ModelHandleCatalog
): Promise<string | undefined> {
  if (!catalog.retiredRefs?.some(ref => ref.startsWith('P'))) return undefined;
  const sources = await listAllDomainRows(database, 'ProcessCompletionSourceLink', { conversation_id: conversationId });
  const candidates = sources.filter(source => modelHandleRef(catalog, 'process', source.process_id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)));
  const descriptions: Array<Record<string, unknown>> = [];
  for (const source of candidates.slice(0, CARD_PROCESS_LIMIT)) {
    const snapshot = await database.snapshot([
      DOMAIN_REPOSITORIES.domain('Process').get(String(source.process_id)),
      DOMAIN_REPOSITORIES.domain('Turn').get(String(source.source_turn_id)),
      DOMAIN_REPOSITORIES.domain('ToolCall').get(String(source.source_tool_call_id))
    ]);
    const [process, turn, call] = snapshot.snapshot;
    if (!process || Array.isArray(process) || !turn || Array.isArray(turn)
      || turn.conversation_id !== conversationId || !call || Array.isArray(call)
      || call.turn_id !== turn.id || (call.tool_name !== 'bash' && call.tool_name !== 'shell')) continue;
    let command: string | undefined;
    if (typeof call.arguments_object_id === 'string') {
      const row = (await database.snapshot([
        DOMAIN_REPOSITORIES.domain('ContentObject').get(call.arguments_object_id)
      ])).snapshot[0];
      if (row && !Array.isArray(row) && Number(row.byte_length) <= COMMAND_METADATA_MAX_BYTES) {
        const args: unknown = JSON.parse((await contentStore.read(row as unknown as ContentObjectMetadata)).toString('utf8'));
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          const text = (args as Record<string, unknown>).command;
          if (typeof text === 'string') command = text.slice(0, 240);
        }
      }
    }
    descriptions.push({
      processRef: modelHandleRef(catalog, 'process', process.id),
      status: process.status, startedAt: process.started_at,
      ...(command !== undefined ? { command } : {})
    });
  }
  return [
    '[Known processes after historical reference repair — runtime data]',
    'These current references identify the described processes. None is an alias for an ambiguous retired reference; choose by the command and facts, never by the old number. Read output without a cursor to start from the beginning.',
    JSON.stringify({ processes: descriptions, omitted: Math.max(0, candidates.length - CARD_PROCESS_LIMIT) })
  ].join('\n');
}

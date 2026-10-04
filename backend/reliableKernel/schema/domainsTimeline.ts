import { domain, integer, text, type RuntimeDomainSchema } from './types';

const id = () => text('id');
const conversation = () => text('conversation_id', { references: { table: 'conversation', onDelete: 'CASCADE' } });
const evidence = (name: string, table: string) => text(name, { nullable: true, references: { table, onDelete: 'RESTRICT' } });
const position = () => [
  // Message identities are immutable evidence, not owners: truncation must not erase an exchange.
  text('predecessor_message_id', { nullable: true }), integer('predecessor_message_seq'),
  integer('exchange_seq'), text('position_basis'), text('created_at')
];
const indexes = ['conversation_id,exchange_seq UNIQUE', 'conversation_id,predecessor_message_seq,exchange_seq'];

/**
 * Independent, typed acceptance relations. They survive input/Turn/Message/peer deletion and are
 * removed only with their own Conversation. Their durable sources are never deleted while that
 * Conversation survives, so a shared MAX+1 allocation cannot reuse an observed exchange sequence.
 */
export const TIMELINE_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = [
  domain({
    key: 'RuntimeDeliveryTimelineLink', table: 'runtime_delivery_timeline_link',
    repository: 'RuntimeDeliveryTimelineLinkRepository', codec: 'RuntimeDeliveryTimelineLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-conversation',
    indexes: ['delivery_id UNIQUE', 'pending_turn_input_id UNIQUE', 'conversation_id,inbox_item_id,exchange_seq', ...indexes],
    columns: [id(), conversation(),
      text('delivery_id', { references: { table: 'runtime_delivery', onDelete: 'RESTRICT' } }),
      text('inbox_item_id', { references: { table: 'runtime_inbox_item', onDelete: 'RESTRICT' } }),
      text('acceptance_kind'), text('pending_turn_input_id', { nullable: true }),
      evidence('context_root_id', 'context_sequence_root'), evidence('context_node_id', 'context_sequence_node'),
      ...position()]
  }),
  domain({
    key: 'CollaborationSendTimelineLink', table: 'collaboration_send_timeline_link',
    repository: 'CollaborationSendTimelineLinkRepository', codec: 'CollaborationSendTimelineLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-conversation',
    indexes: ['message_id UNIQUE', ...indexes],
    columns: [id(), conversation(),
      text('message_id', { references: { table: 'collaboration_message', onDelete: 'RESTRICT' } }),
      ...position()]
  }),
  domain({
    key: 'TimelineImportProvenance', table: 'timeline_import_provenance',
    repository: 'TimelineImportProvenanceRepository', codec: 'TimelineImportProvenanceRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-timeline-link',
    indexes: ['receive_timeline_link_id', 'send_timeline_link_id'],
    columns: [id(),
      text('receive_timeline_link_id', { nullable: true, references: { table: 'runtime_delivery_timeline_link', onDelete: 'CASCADE' } }),
      text('send_timeline_link_id', { nullable: true, references: { table: 'collaboration_send_timeline_link', onDelete: 'CASCADE' } }),
      text('source_data_set_id'), text('source_root_instance_id'), integer('source_exchange_seq')]
  })
];

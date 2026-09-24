import { domain, integer, text, type RuntimeDomainSchema } from './types';

const id = () => text('id');
const ref = (name: string, table: string) => text(name, { references: { table, onDelete: 'CASCADE' } });
const message = () => ref('message_id', 'collaboration_message');

/** Messages, identities, destinations, payloads and requests are independently persisted facts. */
export const COLLABORATION_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = [
  domain({
    key: 'CollaborationMessage', table: 'collaboration_message', repository: 'CollaborationMessageRepository', codec: 'CollaborationMessageRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'dataset-reset-only',
    indexes: ['dedupe_key UNIQUE', 'message_seq UNIQUE', 'created_at,id'],
    columns: [id(), text('dedupe_key'), integer('message_seq'), text('mode'), text('created_at')]
  }),
  domain({
    key: 'CollaborationMessageSourceLink', table: 'collaboration_message_source_link', repository: 'CollaborationMessageSourceLinkRepository', codec: 'CollaborationMessageSourceLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-message',
    indexes: ['message_id UNIQUE', 'conversation_id,created_at', 'source_kind,source_key UNIQUE'],
    columns: [id(), message(), text('conversation_id'), text('source_kind'), text('source_key'), text('turn_id', { nullable: true }), text('tool_call_id', { nullable: true }), text('board_post_id', { nullable: true }), text('created_at')]
  }),
  domain({
    key: 'CollaborationMessageTargetLink', table: 'collaboration_message_target_link', repository: 'CollaborationMessageTargetLinkRepository', codec: 'CollaborationMessageTargetLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-message',
    indexes: ['message_id UNIQUE', 'conversation_id,created_at', 'inbox_item_id UNIQUE'],
    columns: [id(), message(), text('conversation_id'), ref('inbox_item_id', 'runtime_inbox_item'), text('anchor_turn_id', { nullable: true }), text('created_at')]
  }),
  domain({
    key: 'CollaborationMessagePayloadLink', table: 'collaboration_message_payload_link', repository: 'CollaborationMessagePayloadLinkRepository', codec: 'CollaborationMessagePayloadLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-message', indexes: ['message_id UNIQUE', 'content_object_id'],
    columns: [id(), message(), text('content_object_id', { references: { table: 'content_object', onDelete: 'RESTRICT' } }), text('created_at')]
  }),
  domain({
    key: 'CollaborationMessageReplyLink', table: 'collaboration_message_reply_link', repository: 'CollaborationMessageReplyLinkRepository', codec: 'CollaborationMessageReplyLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-message', indexes: ['message_id UNIQUE', 'request_message_id'],
    columns: [id(), message(), ref('request_message_id', 'collaboration_message'), text('created_at')]
  }),
  domain({
    key: 'CollaborationBudget', table: 'collaboration_budget', repository: 'CollaborationBudgetRepository', codec: 'CollaborationBudgetRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'dataset-reset-only',
    indexes: ['origin_kind,origin_key UNIQUE', 'authority_turn_id'],
    columns: [id(), text('origin_kind'), text('origin_key'), text('authority_turn_id'), text('created_at')]
  }),
  domain({
    key: 'CollaborationRequest', table: 'collaboration_request', repository: 'CollaborationRequestRepository', codec: 'CollaborationRequestRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-message',
    indexes: ['message_id UNIQUE', 'budget_id,automatic', 'state,created_at'],
    columns: [id(), message(), ref('budget_id', 'collaboration_budget'), integer('automatic'), text('state'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'CollaborationRequestTurnLink', table: 'collaboration_request_turn_link', repository: 'CollaborationRequestTurnLinkRepository', codec: 'CollaborationRequestTurnLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-request', indexes: ['request_id UNIQUE', 'turn_id'],
    columns: [id(), ref('request_id', 'collaboration_request'), text('turn_id'), text('created_at')]
  })
];

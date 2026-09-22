import { domain, integer, text, type RuntimeDomainSchema } from './types';

const id = () => text('id');
const ref = (name: string, table: string, nullable = false) =>
  text(name, { nullable, references: { table, onDelete: 'CASCADE' } });

/** The board is a projection scoped by existing child lineage; it creates no team authority. */
export const COLLABORATION_BOARD_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = [
  domain({
    key: 'CollaborationBoardChannel', table: 'collaboration_board_channel', repository: 'CollaborationBoardChannelRepository', codec: 'CollaborationBoardChannelRowCodec',
    mutations: ['insert', 'delete'], client: 'none', deletePolicy: 'delete-with-board-root-conversation',
    indexes: ['name'], columns: [id(), text('name'), text('created_at')]
  }),
  domain({
    key: 'CollaborationBoardChannelScopeLink', table: 'collaboration_board_channel_scope_link', repository: 'CollaborationBoardChannelScopeLinkRepository', codec: 'CollaborationBoardChannelScopeLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-channel-or-root-conversation',
    indexes: ['channel_id UNIQUE', 'root_conversation_id,channel_id UNIQUE'],
    columns: [id(), ref('channel_id', 'collaboration_board_channel'), ref('root_conversation_id', 'conversation'), text('created_at')]
  }),
  domain({
    key: 'CollaborationBoardPost', table: 'collaboration_board_post', repository: 'CollaborationBoardPostRepository', codec: 'CollaborationBoardPostRowCodec',
    mutations: ['insert', 'delete'], client: 'none', deletePolicy: 'delete-with-channel',
    indexes: ['created_at'],
    columns: [id(), text('content_object_id', { references: { table: 'content_object', onDelete: 'RESTRICT' } }), integer('character_count'), text('created_at')]
  }),
  domain({
    key: 'CollaborationBoardPostChannelLink', table: 'collaboration_board_post_channel_link', repository: 'CollaborationBoardPostChannelLinkRepository', codec: 'CollaborationBoardPostChannelLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-post-or-channel',
    indexes: ['post_id UNIQUE', 'channel_id,post_id UNIQUE'],
    columns: [id(), ref('post_id', 'collaboration_board_post'), ref('channel_id', 'collaboration_board_channel'), text('created_at')]
  }),
  domain({
    key: 'CollaborationBoardPostSourceLink', table: 'collaboration_board_post_source_link', repository: 'CollaborationBoardPostSourceLinkRepository', codec: 'CollaborationBoardPostSourceLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-post-or-source-tool-call',
    indexes: ['post_id UNIQUE', 'source_kind,source_key UNIQUE', 'source_tool_call_id UNIQUE', 'conversation_id'],
    columns: [id(), ref('post_id', 'collaboration_board_post'), text('source_kind'), text('source_key'), ref('conversation_id', 'conversation'), ref('source_turn_id', 'turn', true), ref('source_tool_call_id', 'tool_call', true), text('created_at')]
  }),
  domain({
    key: 'CollaborationBoardReplyLink', table: 'collaboration_board_reply_link', repository: 'CollaborationBoardReplyLinkRepository', codec: 'CollaborationBoardReplyLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-post-or-thread',
    indexes: ['post_id UNIQUE', 'thread_id,post_id UNIQUE'],
    columns: [id(), ref('post_id', 'collaboration_board_post'), ref('thread_id', 'collaboration_board_post'), text('created_at')]
  }),
  domain({
    key: 'CollaborationBoardSubscriptionLink', table: 'collaboration_board_subscription_link', repository: 'CollaborationBoardSubscriptionLinkRepository', codec: 'CollaborationBoardSubscriptionLinkRowCodec',
    mutations: ['insert', 'update'], client: 'none', deletePolicy: 'cascade-with-subscriber-or-channel-or-thread',
    indexes: ['conversation_id,channel_id UNIQUE WHERE channel_id IS NOT NULL', 'conversation_id,thread_id UNIQUE WHERE thread_id IS NOT NULL', 'channel_id,active', 'thread_id,active'],
    columns: [id(), ref('conversation_id', 'conversation'), ref('channel_id', 'collaboration_board_channel', true), ref('thread_id', 'collaboration_board_post', true), integer('active'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'CollaborationBoardCommandReceipt', table: 'collaboration_board_command_receipt', repository: 'CollaborationBoardCommandReceiptRepository', codec: 'CollaborationBoardCommandReceiptRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-source-tool-call-or-conversation',
    indexes: ['source_kind,source_key UNIQUE', 'source_tool_call_id UNIQUE', 'conversation_id'],
    columns: [id(), text('source_kind'), text('source_key'), ref('conversation_id', 'conversation'), ref('source_tool_call_id', 'tool_call', true), text('operation'), text('request_digest'), text('result_object_id', { references: { table: 'content_object', onDelete: 'RESTRICT' } }), text('created_at')]
  })
];

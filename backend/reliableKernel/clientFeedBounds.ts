export const CLIENT_MAX_INFLIGHT_DATA_MESSAGES = 1;
export const CLIENT_MAX_QUEUED_BATCHES = 8;
export const CLIENT_MAX_QUEUED_BYTES = 4_194_304;
export const CLIENT_MESSAGE_WINDOW_LIMIT = 200;
export const CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE = 200;
/** Tool events are an owner-local progress tail, not part of the structural ToolCall closure. */
export const CLIENT_TOOL_EVENT_SUMMARY_LIMIT_PER_CALL = 32;
export const CLIENT_SNAPSHOT_MAX_BYTES = 5_242_880;
export const CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES = 2_048;
export const CLIENT_CHANGE_BATCH_MAX_RECORDS = 500;
export const CLIENT_CHANGE_BATCH_MAX_BYTES = 1_048_576;
export const CLIENT_PAGE_MAX_ROWS = 200;
export const CLIENT_PAGE_MAX_BYTES = 524_288;
/** One immutable global-sequence window per collaboration read, regardless of the Conversation's size. */
export const CLIENT_COLLABORATION_SCAN_MAX_ROWS = 4096;
export const CLIENT_DETAIL_MAX_RESPONSE_BYTES = 2_097_152;

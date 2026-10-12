import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NativeDatabase = require('better-sqlite3');
const [databasePath, payloadId, rawCount, createdAt] = process.argv.slice(2);
const count = Number(rawCount);
assert.ok(Number.isSafeInteger(count) && count > 0);
const database = new NativeDatabase(databasePath);
database.pragma('foreign_keys = ON');
database.defaultSafeIntegers(true);
try {
  const message = database.prepare(`INSERT INTO collaboration_message
    (id, dedupe_key, mode, message_seq, created_at) VALUES (@id, @id, 'message', @sequence, @createdAt)`);
  const source = database.prepare(`INSERT INTO collaboration_message_source_link
    (id, message_id, conversation_id, source_kind, source_key, turn_id, tool_call_id, created_at)
    VALUES (@sourceId, @id, 'page-other', 'tool', @id, NULL, NULL, @createdAt)`);
  const payload = database.prepare(`INSERT INTO collaboration_message_payload_link
    (id, message_id, content_object_id, created_at) VALUES (@payloadLinkId, @id, @payloadId, @createdAt)`);
  database.transaction(() => {
    const { next } = database.prepare('SELECT COALESCE(MAX(message_seq), 0) + 1 AS next FROM collaboration_message').get();
    for (let index = 1; index <= count; index++) {
      const id = `page-foreign-${index}`;
      const values = { id, sourceId: `${id}-source`, payloadLinkId: `${id}-payload`, payloadId, createdAt,
        sequence: next + BigInt(index - 1) };
      message.run(values);
      source.run(values);
      payload.run(values);
    }
  })();
} finally { database.close(); }

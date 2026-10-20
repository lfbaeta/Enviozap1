CREATE TABLE IF NOT EXISTS chat_messages (
  id text PRIMARY KEY NOT NULL,
  phone text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_phone_created ON chat_messages(phone, created_at);

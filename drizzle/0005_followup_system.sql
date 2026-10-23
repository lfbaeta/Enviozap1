CREATE TABLE IF NOT EXISTS followups (
  id text PRIMARY KEY NOT NULL,
  instance text NOT NULL,
  remote_jid text NOT NULL,
  phone text NOT NULL,
  attempt_number integer NOT NULL,
  cycle_id text NOT NULL,
  scheduled_at text NOT NULL,
  status text DEFAULT 'scheduled' NOT NULL,
  sent_message_id text,
  cancel_reason text,
  error_details text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_followups_uniq ON followups(instance, remote_jid, attempt_number, cycle_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_followups_sched ON followups(status, scheduled_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS conversation_cycles (
  instance text NOT NULL,
  remote_jid text NOT NULL,
  cycle_id text NOT NULL,
  last_user_message_at text,
  last_ai_message_at text,
  status text DEFAULT 'active' NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (instance, remote_jid)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS instance_followup_configs (
  instance_name text PRIMARY KEY NOT NULL,
  config_json text NOT NULL,
  updated_at text NOT NULL
);

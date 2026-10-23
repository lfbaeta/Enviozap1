-- Migration: 0007_reactivation_system.sql
-- 1. Add lead_stage to contacts
ALTER TABLE contacts ADD COLUMN lead_stage text DEFAULT 'novo' NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_lead_stage ON contacts(lead_stage);

-- 2. Add last_question_topic
ALTER TABLE contacts ADD COLUMN last_question_topic text;

-- 3. Reactivations log table (for auditing)
CREATE TABLE IF NOT EXISTS reactivations (
  id text PRIMARY KEY NOT NULL,
  instance text NOT NULL,
  remote_jid text NOT NULL,
  scheduled_at text NOT NULL,
  status text DEFAULT 'scheduled' NOT NULL, -- scheduled | processing | sent | failed
  sent_message_id text,
  error_details text,
  run_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reactivations_status_at ON reactivations(status, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reactivations_unique ON reactivations(instance, remote_jid, scheduled_at);

ALTER TABLE instances ADD COLUMN role text DEFAULT 'ALL' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_human_interventions (
  phone text PRIMARY KEY NOT NULL,
  paused_until text NOT NULL,
  reason text NOT NULL,
  detected_at text NOT NULL
);

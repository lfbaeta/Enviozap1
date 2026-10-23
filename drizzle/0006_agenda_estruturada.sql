CREATE TABLE IF NOT EXISTS contacts_backup_20261023 AS SELECT * FROM contacts;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cities (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  state text DEFAULT '' NOT NULL,
  slug text NOT NULL,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_cities_slug ON cities(slug);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  color text DEFAULT '#64748b' NOT NULL,
  description text,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contact_categories (
  contact_id text NOT NULL,
  category_id text NOT NULL,
  PRIMARY KEY (contact_id, category_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id text NOT NULL,
  tag text NOT NULL,
  PRIMARY KEY (contact_id, tag)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS import_batches (
  id text PRIMARY KEY NOT NULL,
  filename text NOT NULL,
  total integer DEFAULT 0 NOT NULL,
  created integer DEFAULT 0 NOT NULL,
  updated integer DEFAULT 0 NOT NULL,
  skipped integer DEFAULT 0 NOT NULL,
  errors integer DEFAULT 0 NOT NULL,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS import_rows (
  id text PRIMARY KEY NOT NULL,
  batch_id text NOT NULL,
  row_number integer NOT NULL,
  status text NOT NULL,
  reason text,
  data_json text,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id, status);
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN city_id text;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN phone_e164 text;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN phone_raw text;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN email text;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN instagram text;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN address text;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN source text DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN deleted_at text;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN updated_at text;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN import_batch_id text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contacts_phone_e164_unique ON contacts(phone_e164);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_city_id_status_idx ON contacts(city_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_deleted_at_idx ON contacts(deleted_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts(company);
--> statement-breakpoint
INSERT OR IGNORE INTO categories(id, name, slug, color, description, created_at) VALUES ('cat-restaurante', 'Restaurante', 'restaurante', '#ef4444', 'Restaurantes em geral', datetime('now'));
--> statement-breakpoint
INSERT OR IGNORE INTO categories(id, name, slug, color, description, created_at) VALUES ('cat-pizzaria', 'Pizzaria', 'pizzaria', '#f97316', 'Pizzarias e esfiharias', datetime('now'));
--> statement-breakpoint
INSERT OR IGNORE INTO categories(id, name, slug, color, description, created_at) VALUES ('cat-lanchonete', 'Lanchonete', 'lanchonete', '#eab308', 'Lanches e salgados', datetime('now'));
--> statement-breakpoint
INSERT OR IGNORE INTO categories(id, name, slug, color, description, created_at) VALUES ('cat-acai', 'Açaí', 'acai', '#8b5cf6', 'Açaí e sorveterias', datetime('now'));
--> statement-breakpoint
INSERT OR IGNORE INTO categories(id, name, slug, color, description, created_at) VALUES ('cat-padaria', 'Padaria', 'padaria', '#d97706', 'Padarias e confeitarias', datetime('now'));
--> statement-breakpoint
INSERT OR IGNORE INTO categories(id, name, slug, color, description, created_at) VALUES ('cat-hamburgueria', 'Hamburgueria', 'hamburgueria', '#f43f5e', 'Hamburguerias artesanais', datetime('now'));
--> statement-breakpoint
INSERT OR IGNORE INTO categories(id, name, slug, color, description, created_at) VALUES ('cat-bar', 'Bar', 'bar', '#3b82f6', 'Bares e petiscarias', datetime('now'));
--> statement-breakpoint
INSERT OR IGNORE INTO categories(id, name, slug, color, description, created_at) VALUES ('cat-outros', 'Outros', 'outros', '#64748b', 'Demais segmentos alimentícios', datetime('now'));

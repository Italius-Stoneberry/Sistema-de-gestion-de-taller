-- ========== CLIENTES: EMPRESAS Y CONTACTOS (v1.2) ==========
-- Modelo de dos niveles: una empresa (opcional) agrupa varios contactos (personas
-- que piden trabajos). Los clientes chicos pueden ser un contacto sin empresa.
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- búsqueda difusa por similitud de nombres

CREATE TABLE IF NOT EXISTS empresas (
  id             SERIAL PRIMARY KEY,
  nombre         TEXT NOT NULL,
  condicion_pago TEXT NOT NULL DEFAULT 'contado' CHECK (condicion_pago IN ('contado','diferido')),
  telefono       TEXT,
  notas          TEXT,
  origen         TEXT NOT NULL DEFAULT 'manual',
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_empresas_nombre_trgm ON empresas USING gin (nombre gin_trgm_ops);

CREATE TABLE IF NOT EXISTS contactos (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
  telefono   TEXT,
  notas      TEXT,
  origen     TEXT NOT NULL DEFAULT 'manual',
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contactos_nombre_trgm ON contactos USING gin (nombre gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_contactos_empresa ON contactos(empresa_id);

ALTER TABLE trabajos ADD COLUMN IF NOT EXISTS empresa_id  INTEGER REFERENCES empresas(id)  ON DELETE SET NULL;
ALTER TABLE trabajos ADD COLUMN IF NOT EXISTS contacto_id INTEGER REFERENCES contactos(id) ON DELETE SET NULL;

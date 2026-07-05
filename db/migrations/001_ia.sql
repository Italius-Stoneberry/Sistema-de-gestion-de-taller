
-- ========== CAMPOS DE INGESTA POR IA (v1.1) ==========
-- origen: 'manual' (cargado por una persona) o 'ia' (cargado por n8n/LLM).
-- revisado: los cargados por IA entran en FALSE hasta que alguien los confirma.
-- origen_ref: referencia cruda (id de mensaje de WhatsApp, asunto del mail, etc.).
ALTER TABLE trabajos        ADD COLUMN IF NOT EXISTS origen     TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE trabajos        ADD COLUMN IF NOT EXISTS revisado   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE trabajos        ADD COLUMN IF NOT EXISTS origen_ref TEXT;

ALTER TABLE cheques         ADD COLUMN IF NOT EXISTS origen     TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE cheques         ADD COLUMN IF NOT EXISTS revisado   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE cheques         ADD COLUMN IF NOT EXISTS origen_ref TEXT;

ALTER TABLE pagos_servicios ADD COLUMN IF NOT EXISTS origen     TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE pagos_servicios ADD COLUMN IF NOT EXISTS revisado   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE pagos_servicios ADD COLUMN IF NOT EXISTS origen_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_trabajos_revisado ON trabajos(revisado);
CREATE INDEX IF NOT EXISTS idx_cheques_revisado  ON cheques(revisado);
CREATE INDEX IF NOT EXISTS idx_pagos_revisado    ON pagos_servicios(revisado);

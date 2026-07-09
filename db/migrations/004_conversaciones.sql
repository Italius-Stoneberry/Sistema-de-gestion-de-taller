-- Memoria de conversación del asistente por WhatsApp (v1.4)
CREATE TABLE IF NOT EXISTS conversaciones (
  chat_id        TEXT PRIMARY KEY,
  estado         TEXT NOT NULL DEFAULT 'idle',
  datos          JSONB NOT NULL DEFAULT '{}',
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

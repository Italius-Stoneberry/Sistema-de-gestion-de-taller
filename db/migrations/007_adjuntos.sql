-- v1.7 — Adjuntos (imágenes): facturas, fotos de cheques, referencias de diseño de trabajos.
-- Los archivos se guardan en el volumen /app/uploads; en la base solo va la ruta y metadatos.
CREATE TABLE IF NOT EXISTS adjuntos (
  id          SERIAL PRIMARY KEY,
  entidad     TEXT NOT NULL CHECK (entidad IN ('trabajo','cheque')),
  entidad_id  INTEGER NOT NULL,
  archivo     TEXT NOT NULL,           -- ruta relativa dentro del volumen de uploads
  mime        TEXT,
  descripcion TEXT,                    -- caption / "factura" / "referencia", etc.
  origen      TEXT NOT NULL DEFAULT 'manual',
  creado_por  INTEGER REFERENCES usuarios(id),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adjuntos_entidad ON adjuntos(entidad, entidad_id);

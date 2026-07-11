-- v1.5 — Lista de compras del taller (insumos/materiales)
-- Se agrega ítems por WhatsApp ("anotá comprar tinta") y se tachan al comprarlos.
CREATE TABLE IF NOT EXISTS lista_compras (
  id         SERIAL PRIMARY KEY,
  item       TEXT NOT NULL,
  cantidad   TEXT,                       -- texto libre: "2 rollos", "medio kilo"
  comprado   BOOLEAN NOT NULL DEFAULT FALSE,
  origen     TEXT NOT NULL DEFAULT 'manual',
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compras_pendientes ON lista_compras(comprado);

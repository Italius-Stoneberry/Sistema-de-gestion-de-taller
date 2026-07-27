-- v1.9 — Lista de precios para presupuestar rápido.
-- Tres modos según cómo cobra el taller:
--   por_cantidad: precio POR UNIDAD en escalas de 50/100/250/500 (serigrafía, grabado láser CO2/fibra)
--   por_m2:       precio por metro cuadrado (cartelería, ploteo vehicular)
--   por_hora:     precio por hora (diseño)
CREATE TABLE IF NOT EXISTS precios (
  id             SERIAL PRIMARY KEY,
  rubro          TEXT NOT NULL CHECK (rubro IN ('laser','serigrafia','ploteo','impresion','diseno')),
  nombre         TEXT NOT NULL,
  modo           TEXT NOT NULL CHECK (modo IN ('por_cantidad','por_m2','por_hora')),
  costo          NUMERIC(12,2),   -- lo que te sale a vos (unitario / por m² / por hora)
  precio         NUMERIC(12,2),   -- venta por m² o por hora (modos por_m2 / por_hora)
  p50            NUMERIC(12,2),   -- venta POR UNIDAD haciendo 50
  p100           NUMERIC(12,2),   -- ... haciendo 100
  p250           NUMERIC(12,2),
  p500           NUMERIC(12,2),
  notas          TEXT,
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_precios_rubro ON precios(rubro);

-- Ítem "Diseño" inicial (la calculadora usa su tarifa horaria; cargale el valor en la web)
INSERT INTO precios (rubro, nombre, modo, precio)
SELECT 'diseno', 'Diseño', 'por_hora', 0
WHERE NOT EXISTS (SELECT 1 FROM precios WHERE modo = 'por_hora');

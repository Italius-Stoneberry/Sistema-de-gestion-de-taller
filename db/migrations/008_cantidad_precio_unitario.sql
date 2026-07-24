-- v1.8 — Cantidad y precio unitario en trabajos.
-- El total sigue viviendo en "precio" (lo calcula el backend cuando hay cantidad × unitario),
-- así dashboard, consultas, asistente e IVA siguen funcionando sin cambios.
ALTER TABLE trabajos ADD COLUMN IF NOT EXISTS cantidad        NUMERIC(12,2);
ALTER TABLE trabajos ADD COLUMN IF NOT EXISTS precio_unitario NUMERIC(12,2);

-- Agrega la fase previa de cotización a los estados de trabajos (v1.3)
ALTER TABLE trabajos DROP CONSTRAINT IF EXISTS trabajos_estado_check;
ALTER TABLE trabajos ADD CONSTRAINT trabajos_estado_check
  CHECK (estado IN ('cotizar','presupuestado','pedido','en_progreso','en_espera','finalizado'));

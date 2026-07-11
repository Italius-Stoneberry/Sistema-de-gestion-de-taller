-- v1.6 — Nuevo rubro "impresion" y modalidad de cheque (físico vs electrónico/e-check)

-- 1) Agregar 'impresion' como disciplina válida (tarjetería, lonas, fotocopias, etc.)
ALTER TABLE trabajos DROP CONSTRAINT IF EXISTS trabajos_disciplina_check;
ALTER TABLE trabajos ADD CONSTRAINT trabajos_disciplina_check
  CHECK (disciplina IN ('laser','serigrafia','ploteo','impresion'));

-- 2) Modalidad del cheque: 'fisico' (papel) o 'electronico' (e-check / cheque electrónico)
ALTER TABLE cheques ADD COLUMN IF NOT EXISTS modalidad TEXT NOT NULL DEFAULT 'fisico'
  CHECK (modalidad IN ('fisico','electronico'));

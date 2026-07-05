-- Esquema inicial del Sistema de Gestión de Taller
-- Se ejecuta automáticamente la primera vez que arranca el contenedor de PostgreSQL.

-- ========== USUARIOS (login familiar por roles) ==========
CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol           TEXT NOT NULL DEFAULT 'consulta'
                CHECK (rol IN ('admin','gestor','consulta')),
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== TRABAJOS ==========
CREATE TABLE IF NOT EXISTS trabajos (
  id                     SERIAL PRIMARY KEY,
  cliente                TEXT NOT NULL,
  contacto               TEXT,
  descripcion            TEXT,
  disciplina             TEXT NOT NULL
                         CHECK (disciplina IN ('laser','serigrafia','ploteo')),
  estado                 TEXT NOT NULL DEFAULT 'pedido'
                         CHECK (estado IN ('pedido','en_progreso','en_espera','finalizado')),
  -- Subestados de "finalizado": dos ejes independientes
  pagado                 BOOLEAN NOT NULL DEFAULT FALSE,
  facturado              BOOLEAN NOT NULL DEFAULT FALSE,
  precio                 NUMERIC(12,2) DEFAULT 0,
  fecha_ingreso          DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_entrega_estimada DATE,
  fecha_entrega_real     DATE,
  responsable            TEXT,
  notas                  TEXT,
  creado_por             INTEGER REFERENCES usuarios(id),
  creado_en              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trabajos_estado     ON trabajos(estado);
CREATE INDEX IF NOT EXISTS idx_trabajos_disciplina ON trabajos(disciplina);

-- ========== CHEQUES ==========
CREATE TABLE IF NOT EXISTS cheques (
  id            SERIAL PRIMARY KEY,
  tipo          TEXT NOT NULL CHECK (tipo IN ('recibido','emitido')),
  numero        TEXT,
  banco         TEXT,
  importe       NUMERIC(12,2) NOT NULL DEFAULT 0,
  fecha_emision DATE,
  fecha_cobro   DATE,          -- fecha de cobro / vencimiento
  estado        TEXT NOT NULL DEFAULT 'pendiente'
                CHECK (estado IN ('pendiente','cobrado','depositado','rechazado')),
  relacionado   TEXT,          -- cliente o proveedor
  trabajo_id    INTEGER REFERENCES trabajos(id) ON DELETE SET NULL,
  creado_por    INTEGER REFERENCES usuarios(id),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cheques_estado      ON cheques(estado);
CREATE INDEX IF NOT EXISTS idx_cheques_fecha_cobro ON cheques(fecha_cobro);

-- ========== PAGOS DE SERVICIOS ==========
CREATE TABLE IF NOT EXISTS pagos_servicios (
  id                SERIAL PRIMARY KEY,
  concepto          TEXT NOT NULL,        -- luz, gas, alquiler, internet, etc.
  importe           NUMERIC(12,2) NOT NULL DEFAULT 0,
  periodo           TEXT,                 -- ej: 2026-07
  fecha_vencimiento DATE,
  estado            TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (estado IN ('pendiente','pagado')),
  notas             TEXT,
  creado_por        INTEGER REFERENCES usuarios(id),
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos_servicios(estado);

-- ========== BITÁCORA DE AUDITORÍA ==========
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id),
  accion     TEXT NOT NULL,   -- crear, editar, eliminar, cambiar_estado, login
  entidad    TEXT,            -- trabajo, cheque, pago, usuario
  entidad_id INTEGER,
  detalle    JSONB,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_creado_en ON audit_log(creado_en);

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

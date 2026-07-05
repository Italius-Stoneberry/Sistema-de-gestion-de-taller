import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

export const query = (text, params) => pool.query(text, params);

// Registro simple en la bitácora de auditoría. No corta el flujo si falla.
export async function audit(usuarioId, accion, entidad, entidadId, detalle) {
  try {
    await query(
      `INSERT INTO audit_log (usuario_id, accion, entidad, entidad_id, detalle)
       VALUES ($1,$2,$3,$4,$5)`,
      [usuarioId || null, accion, entidad || null, entidadId || null, detalle ? JSON.stringify(detalle) : null]
    );
  } catch (e) {
    console.error('audit error:', e.message);
  }
}

import { query } from './db.js';

// Devuelve el id de una empresa por nombre (case-insensitive); la crea si no existe.
export async function resolverEmpresa(nombre, origen = 'manual') {
  const n = (nombre || '').trim();
  if (!n) return null;
  const { rows } = await query('SELECT id FROM empresas WHERE lower(nombre) = lower($1) LIMIT 1', [n]);
  if (rows[0]) return rows[0].id;
  const ins = await query('INSERT INTO empresas (nombre, origen) VALUES ($1,$2) RETURNING id', [n, origen]);
  return ins.rows[0].id;
}

// Devuelve el id de un contacto por nombre (+ misma empresa o sin empresa); lo crea si no existe.
export async function resolverContacto(nombre, empresaId = null, origen = 'manual') {
  const n = (nombre || '').trim();
  if (!n) return null;
  const { rows } = await query(
    `SELECT id FROM contactos
     WHERE lower(nombre) = lower($1) AND (empresa_id IS NOT DISTINCT FROM $2) LIMIT 1`,
    [n, empresaId]
  );
  if (rows[0]) return rows[0].id;
  const ins = await query(
    'INSERT INTO contactos (nombre, empresa_id, origen) VALUES ($1,$2,$3) RETURNING id',
    [n, empresaId, origen]
  );
  return ins.rows[0].id;
}

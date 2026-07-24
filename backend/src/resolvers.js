import { query } from './db.js';

// ---------- Normalización de nombres ----------
// "  marianela(compras) " -> "Marianela (Compras)". Las siglas (DISAN) se respetan.
export function normalizarNombre(s) {
  let n = String(s || '').trim().replace(/\s+/g, ' ');
  n = n.replace(/\s*\(\s*/g, ' (').replace(/\s*\)\s*/g, ')');
  if (!n) return '';
  return n.split(' ').map((w) => {
    const i = w.search(/[a-zA-ZáéíóúñüÁÉÍÓÚÑÜ]/);
    if (i === -1) return w;
    const pre = w.slice(0, i), resto = w.slice(i);
    if (resto.length > 1 && resto === resto.toUpperCase()) return w; // sigla: DISAN, IPC
    return pre + resto.charAt(0).toUpperCase() + resto.slice(1).toLowerCase();
  }).join(' ');
}

// Clave de comparación: minúsculas, sin acentos, sin espacios ni símbolos.
// "Marianela (Compras)", "marianela(compras)" y " MARIANELA compras " comparten clave.
export const claveNombre = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '');

// Devuelve el id de una empresa por nombre (comparación normalizada); la crea si no existe.
export async function resolverEmpresa(nombre, origen = 'manual') {
  const limpio = normalizarNombre(nombre);
  if (!limpio) return null;
  const clave = claveNombre(limpio);
  const { rows } = await query('SELECT id, nombre FROM empresas');
  const hit = rows.find((r) => claveNombre(r.nombre) === clave);
  if (hit) return hit.id;
  const ins = await query('INSERT INTO empresas (nombre, origen) VALUES ($1,$2) RETURNING id', [limpio, origen]);
  return ins.rows[0].id;
}

// Devuelve el id de un contacto por nombre; lo crea si no existe.
// Reglas anti-duplicados:
//  1) mismo nombre + misma empresa -> ese es.
//  2) sin empresa indicada y hay UN SOLO contacto con ese nombre -> es esa persona.
//  3) con empresa indicada y existe el mismo nombre SIN empresa -> se le asigna la
//     empresa a ese contacto (cura el dato) en vez de crear un duplicado.
//  4) si nada matchea (p. ej. mismo nombre en OTRA empresa), se crea: dos personas
//     con el mismo nombre solo se distinguen por su empresa.
export async function resolverContacto(nombre, empresaId = null, origen = 'manual') {
  const limpio = normalizarNombre(nombre);
  if (!limpio) return null;
  const clave = claveNombre(limpio);
  const { rows } = await query('SELECT id, nombre, empresa_id FROM contactos');
  const mismos = rows.filter((r) => claveNombre(r.nombre) === clave);

  const exacto = mismos.find((r) => (r.empresa_id ?? null) === (empresaId ?? null));
  if (exacto) return exacto.id;
  if (!empresaId && mismos.length === 1) return mismos[0].id;
  if (empresaId) {
    const sinEmpresa = mismos.find((r) => r.empresa_id == null);
    if (sinEmpresa) {
      await query('UPDATE contactos SET empresa_id = $1 WHERE id = $2', [empresaId, sinEmpresa.id]);
      return sinEmpresa.id;
    }
  }
  const ins = await query(
    'INSERT INTO contactos (nombre, empresa_id, origen) VALUES ($1,$2,$3) RETURNING id',
    [limpio, empresaId, origen]
  );
  return ins.rows[0].id;
}

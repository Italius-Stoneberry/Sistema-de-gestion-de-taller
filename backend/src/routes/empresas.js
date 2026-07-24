import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar, soloAdmin } from '../auth.js';
import { normalizarNombre } from '../resolvers.js';

const router = Router();
router.use(requiereAuth);

// GET /api/empresas?buscar=texto  (con búsqueda difusa)
router.get('/', async (req, res) => {
  const { buscar } = req.query;
  let sql = `SELECT e.*, (SELECT COUNT(*)::int FROM contactos c WHERE c.empresa_id = e.id) AS contactos
             FROM empresas e`;
  const vals = [];
  if (buscar) {
    vals.push(buscar);
    sql += ` WHERE e.nombre ILIKE '%'||$1||'%' OR e.nombre % $1
             ORDER BY similarity(e.nombre, $1) DESC, e.nombre`;
  } else {
    sql += ' ORDER BY e.nombre';
  }
  const { rows } = await query(sql, vals);
  res.json(rows);
});

router.post('/', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre) return res.status(400).json({ error: 'Falta el nombre de la empresa' });
  const cond = b.condicion_pago === 'diferido' ? 'diferido' : 'contado';
  const { rows } = await query(
    `INSERT INTO empresas (nombre, condicion_pago, telefono, notas) VALUES ($1,$2,$3,$4) RETURNING *`,
    [normalizarNombre(b.nombre), cond, b.telefono || null, b.notas || null]
  );
  await audit(req.user.id, 'crear', 'empresa', rows[0].id, { nombre: b.nombre });
  res.status(201).json(rows[0]);
});

router.put('/:id', puedeEditar, async (req, res) => {
  const b = req.body || {};
  const cond = b.condicion_pago === 'diferido' ? 'diferido' : (b.condicion_pago === 'contado' ? 'contado' : null);
  const { rows } = await query(
    `UPDATE empresas SET
       nombre = COALESCE($1, nombre),
       condicion_pago = COALESCE($2, condicion_pago),
       telefono = $3, notas = $4
     WHERE id = $5 RETURNING *`,
    [b.nombre ? normalizarNombre(b.nombre) : null, cond, b.telefono ?? null, b.notas ?? null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
  await audit(req.user.id, 'editar', 'empresa', rows[0].id, null);
  res.json(rows[0]);
});

router.delete('/:id', soloAdmin, async (req, res) => {
  const { rowCount } = await query('DELETE FROM empresas WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No encontrada' });
  await audit(req.user.id, 'eliminar', 'empresa', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

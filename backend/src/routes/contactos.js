import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar, soloAdmin } from '../auth.js';

const router = Router();
router.use(requiereAuth);

// GET /api/contactos?buscar=texto&empresa_id=1
router.get('/', async (req, res) => {
  const { buscar, empresa_id } = req.query;
  const cond = [];
  const vals = [];
  if (empresa_id) { vals.push(empresa_id); cond.push(`c.empresa_id = $${vals.length}`); }
  let sql = `SELECT c.*, e.nombre AS empresa_nombre
             FROM contactos c LEFT JOIN empresas e ON e.id = c.empresa_id`;
  let order = ' ORDER BY c.nombre';
  if (buscar) {
    vals.push(buscar);
    cond.push(`(c.nombre ILIKE '%'||$${vals.length}||'%' OR c.nombre % $${vals.length})`);
    order = ` ORDER BY similarity(c.nombre, $${vals.length}) DESC, c.nombre`;
  }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += order;
  const { rows } = await query(sql, vals);
  res.json(rows);
});

router.post('/', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre) return res.status(400).json({ error: 'Falta el nombre del contacto' });
  const { rows } = await query(
    `INSERT INTO contactos (nombre, empresa_id, telefono, notas) VALUES ($1,$2,$3,$4) RETURNING *`,
    [b.nombre.trim(), b.empresa_id || null, b.telefono || null, b.notas || null]
  );
  await audit(req.user.id, 'crear', 'contacto', rows[0].id, { nombre: b.nombre });
  res.status(201).json(rows[0]);
});

router.put('/:id', puedeEditar, async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE contactos SET
       nombre = COALESCE($1, nombre),
       empresa_id = $2, telefono = $3, notas = $4
     WHERE id = $5 RETURNING *`,
    [b.nombre ?? null, b.empresa_id || null, b.telefono ?? null, b.notas ?? null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'editar', 'contacto', rows[0].id, null);
  res.json(rows[0]);
});

router.delete('/:id', soloAdmin, async (req, res) => {
  const { rowCount } = await query('DELETE FROM contactos WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'eliminar', 'contacto', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar } from '../auth.js';

const router = Router();
router.use(requiereAuth);

// GET /api/compras  (filtro: comprado=true|false)
router.get('/', async (req, res) => {
  const { comprado } = req.query;
  const cond = [];
  const vals = [];
  if (comprado === 'true' || comprado === 'false') { vals.push(comprado === 'true'); cond.push(`comprado = $${vals.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await query(
    `SELECT * FROM lista_compras ${where} ORDER BY comprado, creado_en`,
    vals
  );
  res.json(rows);
});

// POST /api/compras
router.post('/', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (!b.item || !b.item.trim()) return res.status(400).json({ error: 'El ítem es obligatorio' });
  const { rows } = await query(
    `INSERT INTO lista_compras (item, cantidad, creado_por) VALUES ($1,$2,$3) RETURNING *`,
    [b.item.trim(), b.cantidad || null, req.user.id]
  );
  await audit(req.user.id, 'crear', 'compra', rows[0].id, null);
  res.status(201).json(rows[0]);
});

// PUT /api/compras/:id  (editar item/cantidad)
router.put('/:id', puedeEditar, async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE lista_compras SET item = COALESCE($1, item), cantidad = $2 WHERE id = $3 RETURNING *`,
    [b.item ?? null, b.cantidad ?? null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
});

// PATCH /api/compras/:id/comprado  (tachar / destachar de un toque)
router.patch('/:id/comprado', puedeEditar, async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    'UPDATE lista_compras SET comprado = $1 WHERE id = $2 RETURNING *',
    [!!b.comprado, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'comprar', 'compra', rows[0].id, { comprado: !!b.comprado });
  res.json(rows[0]);
});

// DELETE /api/compras/:id
router.delete('/:id', puedeEditar, async (req, res) => {
  const { rowCount } = await query('DELETE FROM lista_compras WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'eliminar', 'compra', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

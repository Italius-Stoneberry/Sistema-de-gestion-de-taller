import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar, soloAdmin } from '../auth.js';

const router = Router();
router.use(requiereAuth);

const ESTADOS = ['pendiente', 'pagado'];

// GET /api/pagos  (filtro: estado)
router.get('/', async (req, res) => {
  const { estado, revisado } = req.query;
  const cond = [];
  const vals = [];
  if (estado) { vals.push(estado); cond.push(`estado = $${vals.length}`); }
  if (revisado === 'true' || revisado === 'false') { vals.push(revisado === 'true'); cond.push(`revisado = $${vals.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await query(
    `SELECT * FROM pagos_servicios ${where} ORDER BY fecha_vencimiento NULLS LAST, id DESC`,
    vals
  );
  res.json(rows);
});

// POST /api/pagos
router.post('/', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (!b.concepto) return res.status(400).json({ error: 'El concepto es obligatorio' });
  const { rows } = await query(
    `INSERT INTO pagos_servicios
      (concepto, importe, periodo, fecha_vencimiento, estado, notas, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.concepto, b.importe || 0, b.periodo || null, b.fecha_vencimiento || null,
     ESTADOS.includes(b.estado) ? b.estado : 'pendiente', b.notas || null, req.user.id]
  );
  await audit(req.user.id, 'crear', 'pago', rows[0].id, { concepto: b.concepto });
  res.status(201).json(rows[0]);
});

// PUT /api/pagos/:id
router.put('/:id', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (b.estado && !ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado inválido' });
  const { rows } = await query(
    `UPDATE pagos_servicios SET
       concepto = COALESCE($1, concepto), importe = COALESCE($2, importe),
       periodo = $3, fecha_vencimiento = $4, estado = COALESCE($5, estado), notas = $6
     WHERE id = $7 RETURNING *`,
    [b.concepto ?? null, b.importe ?? null, b.periodo ?? null,
     b.fecha_vencimiento || null, b.estado ?? null, b.notas ?? null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'editar', 'pago', rows[0].id, null);
  res.json(rows[0]);
});

// DELETE /api/pagos/:id  (solo admin)
router.delete('/:id', soloAdmin, async (req, res) => {
  const { rowCount } = await query('DELETE FROM pagos_servicios WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'eliminar', 'pago', Number(req.params.id), null);
  res.json({ ok: true });
});

// PATCH /api/pagos/:id/confirmar
router.patch('/:id/confirmar', puedeEditar, async (req, res) => {
  const { rows } = await query('UPDATE pagos_servicios SET revisado = TRUE WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'confirmar', 'pago', rows[0].id, null);
  res.json(rows[0]);
});

// DELETE /api/pagos/:id/borrador
router.delete('/:id/borrador', puedeEditar, async (req, res) => {
  const { rowCount } = await query('DELETE FROM pagos_servicios WHERE id = $1 AND revisado = FALSE', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No es un borrador pendiente' });
  await audit(req.user.id, 'descartar', 'pago', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

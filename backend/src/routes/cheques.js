import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar, soloAdmin } from '../auth.js';
import { CHEQUE_TIPOS as TIPOS, CHEQUE_MODALIDADES as MODALIDADES, CHEQUE_ESTADOS as ESTADOS } from '../constantes.js';
import { borrarAdjuntosDe } from './adjuntos.js';

const router = Router();
router.use(requiereAuth);

// GET /api/cheques  (filtros: tipo, estado)
router.get('/', async (req, res) => {
  const { tipo, estado, revisado } = req.query;
  const cond = [];
  const vals = [];
  if (tipo) { vals.push(tipo); cond.push(`tipo = $${vals.length}`); }
  if (estado) { vals.push(estado); cond.push(`estado = $${vals.length}`); }
  if (revisado === 'true' || revisado === 'false') { vals.push(revisado === 'true'); cond.push(`revisado = $${vals.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await query(
    `SELECT * FROM cheques ${where} ORDER BY COALESCE(fecha_cobro, fecha_emision) NULLS LAST, id DESC`,
    vals
  );
  res.json(rows);
});

// POST /api/cheques
router.post('/', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (!TIPOS.includes(b.tipo)) return res.status(400).json({ error: 'Tipo inválido' });
  const { rows } = await query(
    `INSERT INTO cheques
      (tipo, modalidad, numero, banco, importe, fecha_emision, fecha_cobro, estado, relacionado, trabajo_id, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.tipo, MODALIDADES.includes(b.modalidad) ? b.modalidad : 'fisico',
     b.numero || null, b.banco || null, b.importe || 0,
     b.fecha_emision || null, b.fecha_cobro || null,
     ESTADOS.includes(b.estado) ? b.estado : 'pendiente',
     b.relacionado || null, b.trabajo_id || null, req.user.id]
  );
  await audit(req.user.id, 'crear', 'cheque', rows[0].id, null);
  res.status(201).json(rows[0]);
});

// PUT /api/cheques/:id
router.put('/:id', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (b.tipo && !TIPOS.includes(b.tipo)) return res.status(400).json({ error: 'Tipo inválido' });
  if (b.estado && !ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado inválido' });
  if (b.modalidad && !MODALIDADES.includes(b.modalidad)) return res.status(400).json({ error: 'Modalidad inválida' });
  const { rows } = await query(
    `UPDATE cheques SET
       tipo = COALESCE($1, tipo), modalidad = COALESCE($2, modalidad), numero = $3, banco = $4,
       importe = COALESCE($5, importe), fecha_emision = $6, fecha_cobro = $7,
       estado = COALESCE($8, estado), relacionado = $9, trabajo_id = $10
     WHERE id = $11 RETURNING *`,
    [b.tipo ?? null, b.modalidad ?? null, b.numero ?? null, b.banco ?? null, b.importe ?? null,
     b.fecha_emision || null, b.fecha_cobro || null, b.estado ?? null,
     b.relacionado ?? null, b.trabajo_id || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'editar', 'cheque', rows[0].id, null);
  res.json(rows[0]);
});

// DELETE /api/cheques/:id  (solo admin)
router.delete('/:id', soloAdmin, async (req, res) => {
  const { rowCount } = await query('DELETE FROM cheques WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No encontrado' });
  await borrarAdjuntosDe('cheque', Number(req.params.id)); // no dejar fotos huérfanas
  await audit(req.user.id, 'eliminar', 'cheque', Number(req.params.id), null);
  res.json({ ok: true });
});

// PATCH /api/cheques/:id/confirmar
router.patch('/:id/confirmar', puedeEditar, async (req, res) => {
  const { rows } = await query('UPDATE cheques SET revisado = TRUE WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'confirmar', 'cheque', rows[0].id, null);
  res.json(rows[0]);
});

// DELETE /api/cheques/:id/borrador
router.delete('/:id/borrador', puedeEditar, async (req, res) => {
  const { rowCount } = await query('DELETE FROM cheques WHERE id = $1 AND revisado = FALSE', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No es un borrador pendiente' });
  await borrarAdjuntosDe('cheque', Number(req.params.id));
  await audit(req.user.id, 'descartar', 'cheque', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

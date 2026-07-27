import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar, soloAdmin } from '../auth.js';

const router = Router();
router.use(requiereAuth);

const RUBROS = ['laser', 'serigrafia', 'ploteo', 'impresion', 'diseno'];
const MODOS = ['por_cantidad', 'por_m2', 'por_hora'];
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// GET /api/precios  (filtro opcional: rubro)
router.get('/', async (req, res) => {
  const { rubro } = req.query;
  const cond = ['activo'];
  const vals = [];
  if (RUBROS.includes(rubro)) { vals.push(rubro); cond.push(`rubro = $${vals.length}`); }
  const { rows } = await query(
    `SELECT * FROM precios WHERE ${cond.join(' AND ')}
     ORDER BY CASE rubro WHEN 'serigrafia' THEN 0 WHEN 'laser' THEN 1 WHEN 'impresion' THEN 2 WHEN 'ploteo' THEN 3 ELSE 4 END, nombre`,
    vals
  );
  res.json(rows);
});

// POST /api/precios
router.post('/', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !b.nombre.trim()) return res.status(400).json({ error: 'Falta el nombre del ítem' });
  if (!RUBROS.includes(b.rubro)) return res.status(400).json({ error: 'Rubro inválido' });
  if (!MODOS.includes(b.modo)) return res.status(400).json({ error: 'Modo inválido' });
  const { rows } = await query(
    `INSERT INTO precios (rubro, nombre, modo, costo, precio, p50, p100, p250, p500, notas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [b.rubro, b.nombre.trim(), b.modo, num(b.costo), num(b.precio),
     num(b.p50), num(b.p100), num(b.p250), num(b.p500), b.notas || null]
  );
  await audit(req.user.id, 'crear', 'precio', rows[0].id, { nombre: b.nombre });
  res.status(201).json(rows[0]);
});

// PUT /api/precios/:id
router.put('/:id', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (b.rubro && !RUBROS.includes(b.rubro)) return res.status(400).json({ error: 'Rubro inválido' });
  if (b.modo && !MODOS.includes(b.modo)) return res.status(400).json({ error: 'Modo inválido' });
  const { rows } = await query(
    `UPDATE precios SET
       rubro = COALESCE($1, rubro), nombre = COALESCE($2, nombre), modo = COALESCE($3, modo),
       costo = $4, precio = $5, p50 = $6, p100 = $7, p250 = $8, p500 = $9, notas = $10,
       actualizado_en = now()
     WHERE id = $11 RETURNING *`,
    [b.rubro ?? null, (b.nombre && b.nombre.trim()) || null, b.modo ?? null,
     num(b.costo), num(b.precio), num(b.p50), num(b.p100), num(b.p250), num(b.p500),
     b.notas || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'editar', 'precio', rows[0].id, null);
  res.json(rows[0]);
});

// DELETE /api/precios/:id  (solo admin)
router.delete('/:id', soloAdmin, async (req, res) => {
  const { rowCount } = await query('DELETE FROM precios WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'eliminar', 'precio', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

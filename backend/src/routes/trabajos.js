import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar, soloAdmin } from '../auth.js';

const router = Router();
router.use(requiereAuth);

const DISCIPLINAS = ['laser', 'serigrafia', 'ploteo'];
const ESTADOS = ['pedido', 'en_progreso', 'en_espera', 'finalizado'];

// GET /api/trabajos  (filtros opcionales: estado, disciplina, pagado, facturado, buscar)
router.get('/', async (req, res) => {
  const { estado, disciplina, pagado, facturado, revisado, buscar } = req.query;
  const cond = [];
  const vals = [];
  const push = (sql, ...args) => { args.forEach((a) => vals.push(a)); cond.push(sql); };

  if (estado) push(`estado = $${vals.length + 1}`, estado);
  if (disciplina) push(`disciplina = $${vals.length + 1}`, disciplina);
  if (pagado === 'true' || pagado === 'false') push(`pagado = $${vals.length + 1}`, pagado === 'true');
  if (facturado === 'true' || facturado === 'false') push(`facturado = $${vals.length + 1}`, facturado === 'true');
  if (revisado === 'true' || revisado === 'false') push(`revisado = $${vals.length + 1}`, revisado === 'true');
  if (buscar) push(`(cliente ILIKE $${vals.length + 1} OR descripcion ILIKE $${vals.length + 2})`, `%${buscar}%`, `%${buscar}%`);

  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await query(
    `SELECT * FROM trabajos ${where} ORDER BY
       CASE estado WHEN 'en_progreso' THEN 0 WHEN 'pedido' THEN 1 WHEN 'en_espera' THEN 2 ELSE 3 END,
       fecha_ingreso DESC, id DESC`,
    vals
  );
  res.json(rows);
});

// GET /api/trabajos/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM trabajos WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
});

// POST /api/trabajos
router.post('/', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (!b.cliente) return res.status(400).json({ error: 'El cliente es obligatorio' });
  if (!DISCIPLINAS.includes(b.disciplina)) return res.status(400).json({ error: 'Disciplina inválida' });

  const { rows } = await query(
    `INSERT INTO trabajos
      (cliente, contacto, descripcion, disciplina, estado, pagado, facturado,
       precio, fecha_entrega_estimada, responsable, notas, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [b.cliente, b.contacto || null, b.descripcion || null, b.disciplina,
     ESTADOS.includes(b.estado) ? b.estado : 'pedido',
     !!b.pagado, !!b.facturado, b.precio || 0,
     b.fecha_entrega_estimada || null, b.responsable || null, b.notas || null, req.user.id]
  );
  await audit(req.user.id, 'crear', 'trabajo', rows[0].id, { cliente: b.cliente });
  res.status(201).json(rows[0]);
});

// PUT /api/trabajos/:id
router.put('/:id', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (b.disciplina && !DISCIPLINAS.includes(b.disciplina)) return res.status(400).json({ error: 'Disciplina inválida' });
  if (b.estado && !ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado inválido' });

  const { rows } = await query(
    `UPDATE trabajos SET
       cliente = COALESCE($1, cliente),
       contacto = $2,
       descripcion = $3,
       disciplina = COALESCE($4, disciplina),
       estado = COALESCE($5, estado),
       pagado = COALESCE($6, pagado),
       facturado = COALESCE($7, facturado),
       precio = COALESCE($8, precio),
       fecha_entrega_estimada = $9,
       fecha_entrega_real = $10,
       responsable = $11,
       notas = $12,
       actualizado_en = now()
     WHERE id = $13 RETURNING *`,
    [b.cliente ?? null, b.contacto ?? null, b.descripcion ?? null, b.disciplina ?? null,
     b.estado ?? null, (b.pagado === undefined ? null : !!b.pagado),
     (b.facturado === undefined ? null : !!b.facturado), b.precio ?? null,
     b.fecha_entrega_estimada || null, b.fecha_entrega_real || null,
     b.responsable ?? null, b.notas ?? null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'editar', 'trabajo', rows[0].id, null);
  res.json(rows[0]);
});

// PATCH /api/trabajos/:id/estado  (cambio rápido de estado)
router.patch('/:id/estado', puedeEditar, async (req, res) => {
  const { estado } = req.body || {};
  if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const { rows } = await query(
    'UPDATE trabajos SET estado = $1, actualizado_en = now() WHERE id = $2 RETURNING *',
    [estado, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'cambiar_estado', 'trabajo', rows[0].id, { estado });
  res.json(rows[0]);
});

// DELETE /api/trabajos/:id  (solo admin)
router.delete('/:id', soloAdmin, async (req, res) => {
  const { rowCount } = await query('DELETE FROM trabajos WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'eliminar', 'trabajo', Number(req.params.id), null);
  res.json({ ok: true });
});

// PATCH /api/trabajos/:id/confirmar  (revisar y aprobar un borrador cargado por IA)
router.patch('/:id/confirmar', puedeEditar, async (req, res) => {
  const { rows } = await query(
    'UPDATE trabajos SET revisado = TRUE, actualizado_en = now() WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'confirmar', 'trabajo', rows[0].id, null);
  res.json(rows[0]);
});

// DELETE /api/trabajos/:id/borrador  (descartar un borrador IA sin ser admin)
router.delete('/:id/borrador', puedeEditar, async (req, res) => {
  const { rowCount } = await query('DELETE FROM trabajos WHERE id = $1 AND revisado = FALSE', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No es un borrador pendiente' });
  await audit(req.user.id, 'descartar', 'trabajo', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

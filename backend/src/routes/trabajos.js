import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar, soloAdmin } from '../auth.js';
import { resolverEmpresa, resolverContacto } from '../resolvers.js';

const router = Router();
router.use(requiereAuth);

const DISCIPLINAS = ['laser', 'serigrafia', 'ploteo'];
const ESTADOS = ['cotizar', 'presupuestado', 'pedido', 'en_progreso', 'en_espera', 'finalizado'];

// Resuelve empresa y contacto a partir de ids o nombres (los crea si no existen).
async function resolverCliente(b, origen = 'manual') {
  let empresaId = null;
  if (b.empresa_id) empresaId = b.empresa_id;
  else if (b.empresa_nombre) empresaId = await resolverEmpresa(b.empresa_nombre, origen);
  let contactoId = null;
  if (b.contacto_id) contactoId = b.contacto_id;
  else if (b.contacto_nombre) contactoId = await resolverContacto(b.contacto_nombre, empresaId, origen);
  return { empresaId, contactoId };
}

// GET /api/trabajos  (filtros opcionales: estado, disciplina, pagado, facturado, buscar)
router.get('/', async (req, res) => {
  const { estado, disciplina, pagado, facturado, revisado, empresa_id, contacto_id, buscar } = req.query;
  const cond = [];
  const vals = [];
  const push = (sql, ...args) => { args.forEach((a) => vals.push(a)); cond.push(sql); };

  if (estado) push(`estado = $${vals.length + 1}`, estado);
  if (disciplina) push(`disciplina = $${vals.length + 1}`, disciplina);
  if (pagado === 'true' || pagado === 'false') push(`pagado = $${vals.length + 1}`, pagado === 'true');
  if (facturado === 'true' || facturado === 'false') push(`facturado = $${vals.length + 1}`, facturado === 'true');
  if (revisado === 'true' || revisado === 'false') push(`revisado = $${vals.length + 1}`, revisado === 'true');
  if (empresa_id) push(`t.empresa_id = $${vals.length + 1}`, empresa_id);
  if (contacto_id) push(`t.contacto_id = $${vals.length + 1}`, contacto_id);
  if (buscar) push(`(cliente ILIKE $${vals.length + 1} OR descripcion ILIKE $${vals.length + 2})`, `%${buscar}%`, `%${buscar}%`);

  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await query(
    `SELECT t.*, e.nombre AS empresa_nombre, c.nombre AS contacto_nombre
     FROM trabajos t
     LEFT JOIN empresas e ON e.id = t.empresa_id
     LEFT JOIN contactos c ON c.id = t.contacto_id
     ${where}
     ORDER BY
       CASE t.estado WHEN 'cotizar' THEN 0 WHEN 'presupuestado' THEN 1 WHEN 'pedido' THEN 2 WHEN 'en_progreso' THEN 3 WHEN 'en_espera' THEN 4 ELSE 5 END,
       t.fecha_ingreso DESC, t.id DESC`,
    vals
  );
  res.json(rows);
});

// GET /api/trabajos/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT t.*, e.nombre AS empresa_nombre, c.nombre AS contacto_nombre
     FROM trabajos t
     LEFT JOIN empresas e ON e.id = t.empresa_id
     LEFT JOIN contactos c ON c.id = t.contacto_id
     WHERE t.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
});

// POST /api/trabajos
router.post('/', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (!DISCIPLINAS.includes(b.disciplina)) return res.status(400).json({ error: 'Disciplina inválida' });

  const { empresaId, contactoId } = await resolverCliente(b);
  const clienteTxt = (b.cliente || b.contacto_nombre || b.empresa_nombre || '').trim();
  if (!clienteTxt) return res.status(400).json({ error: 'Falta el cliente o contacto' });

  const { rows } = await query(
    `INSERT INTO trabajos
      (cliente, contacto, empresa_id, contacto_id, descripcion, disciplina, estado, pagado, facturado,
       precio, fecha_entrega_estimada, responsable, notas, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [clienteTxt, b.contacto || null, empresaId, contactoId, b.descripcion || null, b.disciplina,
     ESTADOS.includes(b.estado) ? b.estado : 'pedido',
     !!b.pagado, !!b.facturado, b.precio || 0,
     b.fecha_entrega_estimada || null, b.responsable || null, b.notas || null, req.user.id]
  );
  await audit(req.user.id, 'crear', 'trabajo', rows[0].id, { cliente: clienteTxt });
  res.status(201).json(rows[0]);
});

// PUT /api/trabajos/:id
router.put('/:id', puedeEditar, async (req, res) => {
  const b = req.body || {};
  if (b.disciplina && !DISCIPLINAS.includes(b.disciplina)) return res.status(400).json({ error: 'Disciplina inválida' });
  if (b.estado && !ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado inválido' });

  const { empresaId, contactoId } = await resolverCliente(b);

  const { rows } = await query(
    `UPDATE trabajos SET
       cliente = COALESCE($1, cliente),
       contacto = $2,
       empresa_id = $3,
       contacto_id = $4,
       descripcion = $5,
       disciplina = COALESCE($6, disciplina),
       estado = COALESCE($7, estado),
       pagado = COALESCE($8, pagado),
       facturado = COALESCE($9, facturado),
       precio = COALESCE($10, precio),
       fecha_entrega_estimada = $11,
       fecha_entrega_real = $12,
       responsable = $13,
       notas = $14,
       actualizado_en = now()
     WHERE id = $15 RETURNING *`,
    [b.cliente ?? null, b.contacto ?? null, empresaId, contactoId, b.descripcion ?? null, b.disciplina ?? null,
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

// PATCH /api/trabajos/:id/rapido  -> cambios de un toque (estado / pagado / facturado) sin tocar el cliente
router.patch('/:id/rapido', puedeEditar, async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.estado !== undefined) {
    if (!ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado inválido' });
    vals.push(b.estado); sets.push(`estado = $${vals.length}`);
  }
  if (b.pagado !== undefined) { vals.push(!!b.pagado); sets.push(`pagado = $${vals.length}`); }
  if (b.facturado !== undefined) { vals.push(!!b.facturado); sets.push(`facturado = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
  vals.push(req.params.id);
  const { rows } = await query(
    `UPDATE trabajos SET ${sets.join(', ')}, actualizado_en = now() WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'rapido', 'trabajo', rows[0].id, b);
  res.json(rows[0]);
});

export default router;

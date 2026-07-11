import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereIngest } from '../auth.js';
import { resolverEmpresa, resolverContacto } from '../resolvers.js';
import { DISCIPLINAS } from '../constantes.js';

const router = Router();
router.use(requiereIngest); // toda la ingesta usa API key (n8n), no login humano

// POST /api/ingesta/trabajo  -> crea un trabajo como BORRADOR (revisado=false) para revisión humana
router.post('/trabajo', async (req, res) => {
  const b = req.body || {};
  const disciplina = DISCIPLINAS.includes(b.disciplina) ? b.disciplina : 'laser';
  let empresaId = b.empresa_id || (b.empresa_nombre ? await resolverEmpresa(b.empresa_nombre, 'ia') : null);
  let contactoId = b.contacto_id || (b.contacto_nombre ? await resolverContacto(b.contacto_nombre, empresaId, 'ia') : null);
  const clienteTxt = (b.cliente || b.contacto_nombre || b.empresa_nombre || 'Sin nombre').trim();
  const { rows } = await query(
    `INSERT INTO trabajos
      (cliente, contacto, empresa_id, contacto_id, descripcion, disciplina, estado, precio, notas,
       origen, revisado, origen_ref)
     VALUES ($1,$2,$3,$4,$5,$6,'pedido',$7,$8,'ia',FALSE,$9) RETURNING *`,
    [clienteTxt, b.contacto || null, empresaId, contactoId, b.descripcion || null, disciplina,
     b.precio || 0, b.notas || null, b.origen_ref || null]
  );
  await audit(null, 'ingesta', 'trabajo', rows[0].id, { origen_ref: b.origen_ref });
  res.status(201).json(rows[0]);
});

// POST /api/ingesta/cheque
router.post('/cheque', async (req, res) => {
  const b = req.body || {};
  const tipo = b.tipo === 'emitido' ? 'emitido' : 'recibido';
  const { rows } = await query(
    `INSERT INTO cheques
      (tipo, numero, banco, importe, fecha_emision, fecha_cobro, relacionado,
       origen, revisado, origen_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ia',FALSE,$8) RETURNING *`,
    [tipo, b.numero || null, b.banco || null, b.importe || 0,
     b.fecha_emision || null, b.fecha_cobro || null, b.relacionado || null, b.origen_ref || null]
  );
  await audit(null, 'ingesta', 'cheque', rows[0].id, { origen_ref: b.origen_ref });
  res.status(201).json(rows[0]);
});

// POST /api/ingesta/pago  -> típico: llega un mail de un servicio
router.post('/pago', async (req, res) => {
  const b = req.body || {};
  if (!b.concepto) return res.status(400).json({ error: 'Falta concepto' });
  const { rows } = await query(
    `INSERT INTO pagos_servicios
      (concepto, importe, periodo, fecha_vencimiento, notas, origen, revisado, origen_ref)
     VALUES ($1,$2,$3,$4,$5,'ia',FALSE,$6) RETURNING *`,
    [b.concepto, b.importe || 0, b.periodo || null, b.fecha_vencimiento || null,
     b.notas || null, b.origen_ref || null]
  );
  await audit(null, 'ingesta', 'pago', rows[0].id, { origen_ref: b.origen_ref });
  res.status(201).json(rows[0]);
});

// POST /api/ingesta/confirmar  -> confirmar o descartar un borrador desde WhatsApp (n8n)
// body: { accion: "confirmar"|"descartar", id? }  (si no hay id, toma el borrador IA más reciente)
router.post('/confirmar', async (req, res) => {
  const b = req.body || {};
  const accion = b.accion === 'descartar' ? 'descartar' : 'confirmar';
  let id = b.id ? Number(b.id) : null;
  if (!id) {
    const r = await query("SELECT id FROM trabajos WHERE revisado = FALSE AND origen = 'ia' ORDER BY creado_en DESC LIMIT 1");
    if (!r.rows[0]) return res.status(404).json({ error: 'No hay borradores pendientes', accion, id: null });
    id = r.rows[0].id;
  }
  if (accion === 'descartar') {
    const { rows } = await query('DELETE FROM trabajos WHERE id = $1 AND revisado = FALSE RETURNING cliente', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'No es un borrador pendiente', accion, id });
    await audit(null, 'descartar', 'trabajo', id, { via: 'whatsapp' });
    return res.json({ ok: true, accion: 'descartado', id, cliente: rows[0].cliente });
  }
  const { rows } = await query('UPDATE trabajos SET revisado = TRUE, actualizado_en = now() WHERE id = $1 RETURNING cliente', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado', accion, id });
  await audit(null, 'confirmar', 'trabajo', id, { via: 'whatsapp' });
  return res.json({ ok: true, accion: 'confirmado', id, cliente: rows[0].cliente });
});

export default router;

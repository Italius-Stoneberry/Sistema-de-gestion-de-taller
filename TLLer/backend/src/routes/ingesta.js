import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereIngest } from '../auth.js';

const router = Router();
router.use(requiereIngest); // toda la ingesta usa API key (n8n), no login humano

const DISCIPLINAS = ['laser', 'serigrafia', 'ploteo'];

// POST /api/ingesta/trabajo  -> crea un trabajo como BORRADOR (revisado=false) para revisión humana
router.post('/trabajo', async (req, res) => {
  const b = req.body || {};
  if (!b.cliente) return res.status(400).json({ error: 'Falta cliente' });
  const disciplina = DISCIPLINAS.includes(b.disciplina) ? b.disciplina : 'laser';
  const { rows } = await query(
    `INSERT INTO trabajos
      (cliente, contacto, descripcion, disciplina, estado, precio, notas,
       origen, revisado, origen_ref)
     VALUES ($1,$2,$3,$4,'pedido',$5,$6,'ia',FALSE,$7) RETURNING *`,
    [b.cliente, b.contacto || null, b.descripcion || null, disciplina,
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

export default router;

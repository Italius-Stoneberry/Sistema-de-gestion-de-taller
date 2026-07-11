import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, audit } from '../db.js';
import { requiereIngest } from '../auth.js';
import { resolverEmpresa, resolverContacto } from '../resolvers.js';

const router = Router();
router.use(requiereIngest);

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const WAHA_URL = process.env.WAHA_URL || 'http://host.docker.internal:3001';
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b';
const DISCIPLINAS = ['laser', 'serigrafia', 'ploteo', 'impresion'];
const ESTADOS = ['cotizar', 'presupuestado', 'pedido', 'en_progreso', 'en_espera', 'finalizado'];
const LBL_ESTADO = { cotizar: 'por cotizar', presupuestado: 'presupuestado', pedido: 'pedido', en_progreso: 'en progreso', en_espera: 'en espera', finalizado: 'finalizado' };
const AUTORIZADOS = (process.env.AUTORIZADOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
const hoyISO = () => new Date().toISOString().slice(0, 10);
const fechaValida = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;
function fmtFecha(d) {
  if (!d) return '';
  const s = (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const p = s.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}` : s;
}

// Esquemas JSON: obligan a qwen3 a LLENAR los campos (con format:"json" a secas
// devuelve {} vacío). Los campos nullable usan type ["...","null"] y van en required
// para forzar que el modelo los emita siempre (aunque sea null).
const NUL = (t) => ({ type: [t, 'null'] });
const SCHEMA = {
  clasificar: {
    type: 'object',
    properties: {
      intencion: { type: 'string', enum: ['nuevo_trabajo', 'actualizar_trabajo', 'consulta', 'ver_activos', 'ver_bandeja', 'ver_sin_presupuestar', 'resumen', 'confirmar', 'descartar', 'nuevo_cheque', 'ver_cheques', 'cheque_cobrado', 'nuevo_pago', 'ver_pagos', 'pago_hecho', 'nueva_compra', 'ver_compras', 'compra_hecha', 'ayuda'] },
      id: NUL('integer'), empresa: NUL('string'), contacto: NUL('string'),
      descripcion: NUL('string'), disciplina: NUL('string'), precio: NUL('integer'),
    },
    required: ['intencion'],
  },
  actualizar: {
    type: 'object',
    properties: {
      ref_id: NUL('integer'), ref_n: NUL('integer'), ref_cliente: NUL('string'),
      estado: NUL('string'), pagado: NUL('boolean'), facturado: NUL('boolean'),
      precio: NUL('integer'), disciplina: NUL('string'),
    },
    required: ['ref_id', 'ref_n', 'ref_cliente', 'estado', 'pagado', 'facturado', 'precio', 'disciplina'],
  },
  consulta: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['facturado_cliente', 'por_cobrar', 'ventas_periodo', 'trabajos_cliente'] },
      cliente: NUL('string'), periodo: NUL('string'),
    },
    required: ['tipo'],
  },
  eligiendo: {
    type: 'object',
    properties: {
      n: NUL('integer'), finalizado: NUL('boolean'), pagado: NUL('boolean'), facturado: NUL('boolean'),
    },
    required: ['n', 'finalizado', 'pagado', 'facturado'],
  },
  cheque: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['recibido', 'emitido'] },
      modalidad: { type: 'string', enum: ['fisico', 'electronico'] },
      importe: NUL('integer'), banco: NUL('string'),
      relacionado: NUL('string'), fecha_cobro: NUL('string'),
    },
    required: ['tipo', 'modalidad', 'importe'],
  },
  pago: {
    type: 'object',
    properties: {
      concepto: { type: 'string' }, importe: NUL('integer'), fecha_vencimiento: NUL('string'),
    },
    required: ['concepto'],
  },
  compra: {
    type: 'object',
    properties: { item: { type: 'string' }, cantidad: NUL('string') },
    required: ['item'],
  },
  refNombre: {
    type: 'object',
    properties: { nombre: NUL('string') },
    required: ['nombre'],
  },
};

async function ollamaJSON(prompt, schema) {
  try {
    const r = await fetch(OLLAMA_URL + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, think: false, format: schema || 'json', options: { temperature: 0 } }),
    });
    const j = await r.json();
    if (!j || typeof j.response !== 'string' || !j.response.trim()) {
      // Ollama respondió pero sin texto útil (p. ej. {"error":"model ... not found"}).
      console.error('ollama sin response (modelo=' + OLLAMA_MODEL + '):', JSON.stringify(j).slice(0, 300));
      return {};
    }
    return JSON.parse(j.response);
  } catch (e) { console.error('ollama fetch/parse:', e.message); return {}; }
}

async function getCtx(chatId) {
  const { rows } = await query('SELECT estado, datos FROM conversaciones WHERE chat_id = $1', [chatId]);
  return rows[0] || { estado: 'idle', datos: {} };
}
async function setCtx(chatId, estado, datos) {
  await query(`INSERT INTO conversaciones (chat_id, estado, datos, actualizado_en) VALUES ($1,$2,$3,now())
     ON CONFLICT (chat_id) DO UPDATE SET estado = $2, datos = $3, actualizado_en = now()`,
    [chatId, estado, JSON.stringify(datos || {})]);
}

async function contextoClientes() {
  const emp = await query('SELECT nombre FROM empresas ORDER BY creado_en DESC LIMIT 40');
  const con = await query('SELECT c.nombre, e.nombre AS empresa FROM contactos c LEFT JOIN empresas e ON e.id = c.empresa_id ORDER BY c.creado_en DESC LIMIT 40');
  const empresas = emp.rows.map((r) => r.nombre).join(', ') || '(ninguna aún)';
  const contactos = con.rows.map((r) => (r.empresa ? `${r.nombre} (${r.empresa})` : r.nombre)).join(', ') || '(ninguno aún)';
  return `Empresas conocidas: ${empresas}.\nContactos conocidos (personas): ${contactos}.`;
}

async function contar() {
  const { rows } = await query(`SELECT
      COUNT(*) FILTER (WHERE estado IN ('pedido','en_progreso','en_espera') AND revisado)::int AS activos,
      COUNT(*) FILTER (WHERE revisado = FALSE)::int AS bandeja,
      COUNT(*) FILTER (WHERE estado = 'cotizar' AND revisado)::int AS sin_presup
    FROM trabajos`);
  return rows[0];
}
async function menuTexto() {
  const c = await contar();
  return `🤖 ¡Buenas! Tenés:\n• ${c.activos} trabajos en curso\n• ${c.bandeja} en la bandeja sin confirmar\n• ${c.sin_presup} sin presupuestar\n\nHablame normal: cargá pedidos, actualizá estados, anotá cheques ("me dieron un cheque de X"), pagos ("hay que pagar la luz") o compras ("falta tinta"). También preguntame "qué me deben", "ver cheques", "ver compras".`;
}
function ayudaTexto() {
  return `🤖 Soy tu asistente del taller. Hablame como quieras, en criollo. Esto es lo que puedo hacer:\n\n`
    + `📋 *TRABAJOS*\n`
    + `• Cargar: "ramiro quiere 100 volantes a 80 lucas"\n`
    + `• Actualizar: "el de andreu se entregó y se cobró", "poné el 3 en espera"\n`
    + `• Presupuestar: "presupuestá el 5 en 40 lucas"\n\n`
    + `🧾 *CHEQUES*\n`
    + `• Anotar: "me dieron un cheque de andreu por 200 lucas a 30 días"\n`
    + `• Ver / cobrar: "ver cheques", "cobré el cheque de andreu"\n\n`
    + `💡 *PAGOS Y SERVICIOS*\n`
    + `• Anotar: "hay que pagar la luz 30 lucas el viernes"\n`
    + `• Ver / pagar: "ver pagos", "pagué la luz"\n\n`
    + `🛒 *COMPRAS*\n`
    + `• Anotar: "falta tinta negra"\n`
    + `• Ver / tachar: "ver compras", "ya compré la tinta"\n\n`
    + `📷 *FOTOS*\n`
    + `• Mandame una foto (cheque, factura, la camioneta, un diseño) y decime a qué va en el texto de la foto: "para el 5", "cheque de garcía". Si no, te pregunto.\n\n`
    + `❓ *PREGUNTARME*\n`
    + `• "¿qué me deben?", "¿cuánto le facturé a andreu?", "¿cuánto vendí este mes?", "trabajos de ramiro"\n\n`
    + `Cuando anoto algo te pido confirmación: respondé *"ok"* para guardarlo o *"no"* para descartarlo.\n`
    + `Escribí *"menu"* para el resumen del día, o *"ayuda"* para ver esto de nuevo. 👍`;
}
async function listarActivos(chatId) {
  const { rows } = await query(`SELECT id, cliente, descripcion, estado FROM trabajos WHERE estado IN ('pedido','en_progreso','en_espera') AND revisado ORDER BY actualizado_en ASC LIMIT 8`);
  if (!rows.length) { if (chatId) await setCtx(chatId, 'idle', {}); return 'No hay trabajos en curso 👍'; }
  const lista = rows.map((r, i) => ({ n: i + 1, id: r.id, cliente: r.cliente, descripcion: r.descripcion, estado: r.estado }));
  if (chatId) await setCtx(chatId, 'eligiendo', { lista });
  return 'Trabajos en curso:\n' + lista.map((x) => `${x.n}) #${x.id} ${x.cliente} — ${x.descripcion || ''} [${LBL_ESTADO[x.estado]}]`).join('\n') + '\n\nContame qué pasó, ej: "el 1 se terminó y se cobró".';
}
async function listarBandeja() {
  const tr = await query('SELECT id, cliente, descripcion, precio FROM trabajos WHERE revisado = FALSE ORDER BY creado_en DESC LIMIT 10');
  const ch = await query('SELECT id, tipo, relacionado, importe FROM cheques WHERE revisado = FALSE ORDER BY creado_en DESC LIMIT 10');
  if (!tr.rows.length && !ch.rows.length) return 'La bandeja está vacía 👍';
  const lineas = [];
  if (tr.rows.length) lineas.push('Trabajos:\n' + tr.rows.map((r) => `#${r.id} ${r.cliente} — ${r.descripcion || ''} (${money(r.precio)})`).join('\n'));
  if (ch.rows.length) lineas.push('Cheques:\n' + ch.rows.map((r) => `#${r.id} ${r.tipo === 'recibido' ? 'de' : 'a'} ${r.relacionado || '—'} ${money(r.importe)}`).join('\n'));
  return 'Bandeja (sin confirmar):\n' + lineas.join('\n\n') + '\n\nRespondé "ok" para confirmar el último, o "ok #<n>" / "no #<n>" para uno puntual.';
}
async function listarSinPresup() {
  const { rows } = await query("SELECT id, cliente, descripcion FROM trabajos WHERE estado = 'cotizar' AND revisado ORDER BY creado_en ASC LIMIT 10");
  if (!rows.length) return 'No hay nada sin presupuestar 👍';
  return 'Sin presupuestar:\n' + rows.map((r) => `#${r.id} ${r.cliente} — ${r.descripcion || ''}`).join('\n');
}

async function aplicar(id, c) {
  const sets = []; const vals = [];
  if (c.estado) { vals.push(c.estado); sets.push(`estado = $${vals.length}`); }
  else if (c.finalizado === true) { vals.push('finalizado'); sets.push(`estado = $${vals.length}`); }
  if (c.pagado === true || c.pagado === false) { vals.push(c.pagado); sets.push(`pagado = $${vals.length}`); }
  if (c.facturado === true || c.facturado === false) { vals.push(c.facturado); sets.push(`facturado = $${vals.length}`); }
  if (typeof c.precio === 'number' && c.precio > 0) { vals.push(c.precio); sets.push(`precio = $${vals.length}`); }
  if (DISCIPLINAS.includes(c.disciplina)) { vals.push(c.disciplina); sets.push(`disciplina = $${vals.length}`); }
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await query(`UPDATE trabajos SET ${sets.join(', ')}, actualizado_en = now() WHERE id = $${vals.length} RETURNING *`, vals);
  await audit(null, 'asistente', 'trabajo', id, c);
  return rows[0];
}
async function crearBorradorDesde(d) {
  const empresaId = (d.empresa && d.empresa.trim()) ? await resolverEmpresa(d.empresa.trim(), 'ia') : null;
  const contactoId = (d.contacto && d.contacto.trim()) ? await resolverContacto(d.contacto.trim(), empresaId, 'ia') : null;
  const cliente = (d.contacto && d.contacto.trim()) ? (d.contacto.trim() + (d.empresa && d.empresa.trim() ? ` (${d.empresa.trim()})` : '')) : ((d.empresa && d.empresa.trim()) || 'Sin nombre');
  const disciplina = DISCIPLINAS.includes(d.disciplina) ? d.disciplina : 'laser';
  const { rows } = await query(
    `INSERT INTO trabajos (cliente, empresa_id, contacto_id, descripcion, disciplina, estado, precio, origen, revisado, origen_ref)
     VALUES ($1,$2,$3,$4,$5,'pedido',$6,'ia',FALSE,$7) RETURNING *`,
    [cliente, empresaId, contactoId, d.descripcion || null, disciplina, Number(d.precio) || 0, 'WhatsApp']);
  await audit(null, 'ingesta', 'trabajo', rows[0].id, null);
  return rows[0];
}
// Confirma o descarta un borrador concreto (trabajo/cheque/pago) por tipo + id.
async function confirmarEntidad(tipo, accion, id) {
  const tabla = tipo === 'cheque' ? 'cheques' : tipo === 'pago' ? 'pagos_servicios' : 'trabajos';
  if (accion === 'descartar') {
    const { rows } = await query(`DELETE FROM ${tabla} WHERE id = $1 AND revisado = FALSE RETURNING id`, [id]);
    return rows[0] ? { accion: 'descartado', id } : null;
  }
  const { rows } = await query(`UPDATE ${tabla} SET revisado = TRUE WHERE id = $1 RETURNING id`, [id]);
  return rows[0] ? { accion: 'confirmado', id } : null;
}
async function confirmarBorrador(accion, id) {
  if (!id) {
    const r = await query("SELECT id FROM trabajos WHERE revisado = FALSE AND origen = 'ia' ORDER BY creado_en DESC LIMIT 1");
    if (!r.rows[0]) return null; id = r.rows[0].id;
  }
  if (accion === 'descartar') {
    const { rows } = await query('DELETE FROM trabajos WHERE id = $1 AND revisado = FALSE RETURNING cliente', [id]);
    return rows[0] ? { accion: 'descartado', id, cliente: rows[0].cliente } : null;
  }
  const { rows } = await query('UPDATE trabajos SET revisado = TRUE, actualizado_en = now() WHERE id = $1 RETURNING cliente', [id]);
  return rows[0] ? { accion: 'confirmado', id, cliente: rows[0].cliente } : null;
}

// ---- Editar hablando: resolver referencia y aplicar ----
async function resolverRef(u, ctx) {
  if (u.ref_id) return { id: Number(u.ref_id) };
  if (u.ref_n && ctx.datos && ctx.datos.lista) {
    const it = ctx.datos.lista.find((x) => x.n == u.ref_n);
    if (it) return { id: it.id };
  }
  if (u.ref_cliente) {
    const { rows } = await query(
      "SELECT id FROM trabajos WHERE cliente ILIKE '%'||$1||'%' ORDER BY (estado <> 'finalizado') DESC, actualizado_en DESC LIMIT 3",
      [u.ref_cliente]);
    if (rows.length === 1) return { id: rows[0].id };
    if (rows.length > 1) return { multiple: rows.map((r) => r.id) };
  }
  return {};
}

// ---- Consultas ----
function filtroPeriodoSQL(periodo, idx) {
  if (periodo === 'hoy') return ` AND actualizado_en >= date_trunc('day', now())`;
  if (periodo === 'semana') return ` AND actualizado_en >= now() - interval '7 days'`;
  if (periodo === 'mes') return ` AND actualizado_en >= date_trunc('month', now())`;
  return '';
}
function etiquetaPeriodo(p) { return p === 'hoy' ? ' hoy' : p === 'semana' ? ' esta semana' : p === 'mes' ? ' este mes' : ''; }

async function responderConsulta(q) {
  const tipo = q.tipo;
  const per = etiquetaPeriodo(q.periodo);
  const perSQL = filtroPeriodoSQL(q.periodo);
  if (tipo === 'facturado_cliente' && q.cliente) {
    const { rows } = await query(`SELECT COUNT(*)::int n, COALESCE(SUM(precio),0) total FROM trabajos WHERE estado='finalizado' AND facturado AND cliente ILIKE '%'||$1||'%'` + perSQL, [q.cliente]);
    return `Facturado a ${q.cliente}${per}: ${money(rows[0].total)} en ${rows[0].n} trabajo(s).`;
  }
  if (tipo === 'por_cobrar') {
    if (q.cliente) {
      const { rows } = await query(`SELECT COUNT(*)::int n, COALESCE(SUM(precio),0) total FROM trabajos WHERE estado='finalizado' AND NOT pagado AND cliente ILIKE '%'||$1||'%'`, [q.cliente]);
      return `${q.cliente} te debe ${money(rows[0].total)} (${rows[0].n} trabajo(s) sin cobrar).`;
    }
    const { rows } = await query(`SELECT COUNT(*)::int n, COALESCE(SUM(precio),0) total FROM trabajos WHERE estado='finalizado' AND NOT pagado`);
    return `Por cobrar en total: ${money(rows[0].total)} (${rows[0].n} trabajo(s) finalizados sin cobrar).`;
  }
  if (tipo === 'ventas_periodo') {
    const { rows } = await query(`SELECT COUNT(*)::int n, COALESCE(SUM(precio),0) total FROM trabajos WHERE estado='finalizado'` + perSQL);
    return `Ventas${per || ' (total)'}: ${money(rows[0].total)} en ${rows[0].n} trabajo(s) finalizados.`;
  }
  if (tipo === 'trabajos_cliente' && q.cliente) {
    const { rows } = await query(`SELECT id, descripcion, estado, precio FROM trabajos WHERE cliente ILIKE '%'||$1||'%' ORDER BY actualizado_en DESC LIMIT 10`, [q.cliente]);
    if (!rows.length) return `No encontré trabajos de ${q.cliente}.`;
    return `Trabajos de ${q.cliente}:\n` + rows.map((r) => `#${r.id} ${r.descripcion || ''} [${LBL_ESTADO[r.estado]}] ${money(r.precio)}`).join('\n');
  }
  return 'No pude armar esa consulta. Probá: "cuánto le facturé a Andreu", "qué me deben", "cuánto vendí este mes", "trabajos de Ramiro".';
}

// ---- Cheques ----
async function crearCheque(d) {
  const tipo = d.tipo === 'emitido' ? 'emitido' : 'recibido';
  const modalidad = d.modalidad === 'electronico' ? 'electronico' : 'fisico';
  // Nace como BORRADOR (revisado=FALSE): entra a la Bandeja hasta que se confirma.
  const { rows } = await query(
    `INSERT INTO cheques (tipo, modalidad, banco, importe, fecha_cobro, estado, relacionado, origen, revisado, origen_ref)
     VALUES ($1,$2,$3,$4,$5,'pendiente',$6,'ia',FALSE,'WhatsApp') RETURNING *`,
    [tipo, modalidad, d.banco || null, Number(d.importe) || 0, fechaValida(d.fecha_cobro), d.relacionado || null]);
  await audit(null, 'ingesta', 'cheque', rows[0].id, null);
  return rows[0];
}
async function listarCheques() {
  const { rows } = await query(`SELECT id, tipo, importe, relacionado, fecha_cobro FROM cheques WHERE estado='pendiente' ORDER BY fecha_cobro NULLS LAST, id LIMIT 12`);
  if (!rows.length) return 'No hay cheques pendientes 👍';
  return 'Cheques pendientes:\n' + rows.map((r) => `#${r.id} ${r.tipo === 'recibido' ? 'a cobrar de' : 'a pagar a'} ${r.relacionado || '—'} ${money(r.importe)}${r.fecha_cobro ? ` (${fmtFecha(r.fecha_cobro)})` : ''}`).join('\n') + '\n\nDecime "cobré el cheque de X" cuando entre.';
}
async function marcarChequeCobrado(nombre) {
  const cond = nombre ? `relacionado ILIKE '%'||$1||'%'` : 'TRUE';
  const args = nombre ? [nombre] : [];
  const { rows } = await query(
    `UPDATE cheques SET estado='cobrado' WHERE id=(SELECT id FROM cheques WHERE estado='pendiente' AND ${cond} ORDER BY fecha_cobro NULLS LAST, id LIMIT 1) RETURNING *`, args);
  if (rows[0]) await audit(null, 'asistente', 'cheque', rows[0].id, { estado: 'cobrado' });
  return rows[0];
}

// ---- Pagos de servicios / gastos fijos ----
async function crearPago(d) {
  const { rows } = await query(
    `INSERT INTO pagos_servicios (concepto, importe, fecha_vencimiento, estado, origen, revisado)
     VALUES ($1,$2,$3,'pendiente','ia',TRUE) RETURNING *`,
    [d.concepto || 'gasto', Number(d.importe) || 0, fechaValida(d.fecha_vencimiento)]);
  await audit(null, 'asistente', 'pago', rows[0].id, null);
  return rows[0];
}
async function listarPagos() {
  const { rows } = await query(`SELECT id, concepto, importe, fecha_vencimiento FROM pagos_servicios WHERE estado='pendiente' ORDER BY fecha_vencimiento NULLS LAST, id LIMIT 12`);
  if (!rows.length) return 'No hay pagos pendientes 👍';
  return 'Pagos pendientes:\n' + rows.map((r) => `#${r.id} ${r.concepto} ${money(r.importe)}${r.fecha_vencimiento ? ` (vence ${fmtFecha(r.fecha_vencimiento)})` : ''}`).join('\n') + '\n\nDecime "pagué la luz" cuando lo saldes.';
}
async function marcarPagoHecho(nombre) {
  const cond = nombre ? `concepto ILIKE '%'||$1||'%'` : 'TRUE';
  const args = nombre ? [nombre] : [];
  const { rows } = await query(
    `UPDATE pagos_servicios SET estado='pagado' WHERE id=(SELECT id FROM pagos_servicios WHERE estado='pendiente' AND ${cond} ORDER BY fecha_vencimiento NULLS LAST, id LIMIT 1) RETURNING *`, args);
  if (rows[0]) await audit(null, 'asistente', 'pago', rows[0].id, { estado: 'pagado' });
  return rows[0];
}

// ---- Lista de compras ----
async function crearCompra(d) {
  const { rows } = await query(
    `INSERT INTO lista_compras (item, cantidad, origen) VALUES ($1,$2,'ia') RETURNING *`,
    [(d.item || '').trim() || 'insumo', d.cantidad || null]);
  return rows[0];
}
async function listarCompras() {
  const { rows } = await query(`SELECT item, cantidad FROM lista_compras WHERE NOT comprado ORDER BY creado_en LIMIT 30`);
  if (!rows.length) return 'La lista de compras está vacía 👍';
  return '🛒 Lista de compras:\n' + rows.map((r) => `• ${r.item}${r.cantidad ? ` (${r.cantidad})` : ''}`).join('\n') + '\n\nDecime "ya compré X" para tacharlo.';
}
async function marcarCompraHecha(nombre) {
  const cond = nombre ? `item ILIKE '%'||$1||'%'` : 'TRUE';
  const args = nombre ? [nombre] : [];
  const { rows } = await query(
    `UPDATE lista_compras SET comprado=TRUE WHERE id=(SELECT id FROM lista_compras WHERE NOT comprado AND ${cond} ORDER BY creado_en LIMIT 1) RETURNING *`, args);
  return rows[0];
}

// ---- Secretario proactivo: resumen de pendientes ----
async function nudgeTexto() {
  const c = await contar();
  const q = async (sql) => (await query(sql)).rows[0];
  const chq = await q(`SELECT COUNT(*)::int n, COALESCE(SUM(importe),0) t FROM cheques WHERE estado='pendiente' AND fecha_cobro IS NOT NULL AND fecha_cobro <= CURRENT_DATE + INTERVAL '5 days'`);
  const pag = await q(`SELECT COUNT(*)::int n FROM pagos_servicios WHERE estado='pendiente' AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '5 days'`);
  const esp = await q(`SELECT COUNT(*)::int n FROM trabajos WHERE estado='en_espera' AND revisado`);
  const comp = await q(`SELECT COUNT(*)::int n FROM lista_compras WHERE NOT comprado`);
  const L = ['🤖 ¿Cómo venís? Te recuerdo lo que hay:'];
  L.push(`• ${c.activos} trabajo(s) en curso${esp.n ? `, ${esp.n} en espera` : ''}`);
  if (c.bandeja) L.push(`• ${c.bandeja} en la bandeja sin confirmar`);
  if (c.sin_presup) L.push(`• ${c.sin_presup} sin presupuestar`);
  if (chq.n) L.push(`• ${chq.n} cheque(s) por cobrar pronto (${money(chq.t)})`);
  if (pag.n) L.push(`• ${pag.n} pago(s) por vencer`);
  if (comp.n) L.push(`• 🛒 ${comp.n} cosa(s) en la lista de compras`);
  L.push('\n¿Algún trabajo avanzó o cobraste algo? Contame y lo actualizo. 👍');
  return L.join('\n');
}

// ---- Imágenes / adjuntos que llegan por WhatsApp ----
async function bajarImagenWaha(mediaUrl) {
  // La URL que da WAHA apunta a su propio host; la reescribimos para alcanzarlo desde el contenedor.
  let url = mediaUrl;
  try {
    const u = new URL(mediaUrl);
    const base = new URL(WAHA_URL);
    u.protocol = base.protocol; u.host = base.host;
    url = u.toString();
  } catch { /* si no es URL válida, se usa tal cual */ }
  const r = await fetch(url, { headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {} });
  if (!r.ok) throw new Error('WAHA media ' + r.status);
  const mime = r.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, mime };
}
const extDeMime = (m) => (m && m.includes('png')) ? 'png' : (m && m.includes('webp')) ? 'webp' : (m && m.includes('pdf')) ? 'pdf' : 'jpg';
async function guardarArchivo(buf, mime) {
  const dir = path.join(UPLOADS_DIR, 'whatsapp');
  await fs.promises.mkdir(dir, { recursive: true });
  const nombre = crypto.randomUUID() + '.' + extDeMime(mime);
  await fs.promises.writeFile(path.join(dir, nombre), buf);
  return path.join('whatsapp', nombre); // ruta relativa al volumen de uploads
}
async function adjuntar(entidad, entidadId, archivo, mime, descripcion) {
  const { rows } = await query(
    `INSERT INTO adjuntos (entidad, entidad_id, archivo, mime, descripcion, origen) VALUES ($1,$2,$3,$4,$5,'ia') RETURNING *`,
    [entidad, entidadId, archivo, mime, descripcion || null]);
  await audit(null, 'ingesta', 'adjunto', rows[0].id, { entidad, entidadId });
  return rows[0];
}
// Resuelve a qué trabajo o cheque va la foto, a partir del caption o de la respuesta del usuario.
async function resolverObjetivo(texto, ctx) {
  const txt = (texto || '').trim();
  if (!txt) return {};
  const esCheque = /cheque|e-?check/i.test(txt);
  const idTxt = txt.match(/#?(\d{1,6})/);
  const u = await ollamaJSON(promptActualizar(txt, ''), SCHEMA.actualizar);
  const refId = u.ref_id || (idTxt ? Number(idTxt[1]) : null);
  if (esCheque) {
    if (refId) { const r = await query('SELECT relacionado FROM cheques WHERE id=$1', [refId]); if (r.rows[0]) return { tipo: 'cheque', id: refId, nombre: r.rows[0].relacionado }; }
    if (u.ref_cliente) { const r = await query("SELECT id, relacionado FROM cheques WHERE relacionado ILIKE '%'||$1||'%' ORDER BY creado_en DESC LIMIT 1", [u.ref_cliente]); if (r.rows[0]) return { tipo: 'cheque', id: r.rows[0].id, nombre: r.rows[0].relacionado }; }
    return {};
  }
  if (refId) { const r = await query('SELECT cliente FROM trabajos WHERE id=$1', [refId]); if (r.rows[0]) return { tipo: 'trabajo', id: refId, nombre: r.rows[0].cliente }; }
  if (u.ref_n && ctx.datos && ctx.datos.lista) { const it = ctx.datos.lista.find((x) => x.n == u.ref_n); if (it) return { tipo: 'trabajo', id: it.id }; }
  if (u.ref_cliente) { const r = await query("SELECT id, cliente FROM trabajos WHERE cliente ILIKE '%'||$1||'%' ORDER BY (estado<>'finalizado') DESC, actualizado_en DESC LIMIT 1", [u.ref_cliente]); if (r.rows[0]) return { tipo: 'trabajo', id: r.rows[0].id, nombre: r.rows[0].cliente }; }
  return {};
}

const esSi = (t) => /^(s[ií]|dale|obvio|sip|yes|ya|listo)\b/i.test(t);
const esNo = (t) => /^(no|nop|todav[ií]a|a[uú]n no|negativo)\b/i.test(t);
const esSaludo = (t) => ['hola', 'menu', 'menú', 'inicio', 'buenas', 'empezar', 'buen dia'].includes(t);
const esSalir = (t) => ['salir', 'chau', 'gracias', 'nada'].includes(t);
const esAyuda = (t) => /\bayuda\b|\bhelp\b|qu[eé] (puedo|pod[eé]s|se puede|podemos|sabes|sab[eé]s) hacer|para qu[eé] serv[ií]s|c[oó]mo funciona|qu[eé] hac[eé]s/i.test(t);

function promptClasificar(texto, ctxNegocio) {
  return `Sos el asistente de un taller gráfico. Interpretás WhatsApp informal (jerga argentina).\n\n${ctxNegocio}\n\n`
    + `El usuario escribió: "${texto}".\nDevolvé SOLO un JSON con:\n`
    + `- "intencion": una de las de la lista.\n`
    + `- "id": número de trabajo si menciona uno (#5), si no null.\n`
    + `- si es nuevo_trabajo: "empresa", "contacto", "descripcion", "disciplina" (laser|serigrafia|ploteo|impresion), "precio" (entero, 0 si no hay). impresion = tarjetería, lonas, fotocopias, folletería y afines.\n\n`
    + `Cómo elegir la intención:\n`
    + `- nuevo_trabajo: encarga un TRABAJO por primera vez (cliente + cantidad/producto). Ej: "ramiro quiere 100 volantes".\n`
    + `- actualizar_trabajo: cambio sobre un trabajo YA existente (se terminó/cobró/facturó, cambiar estado/precio/disciplina, presupuestar). Ej: "el de andreu se entregó", "poné el 3 en espera", "presupuestá el 5 en 40 lucas".\n`
    + `- consulta: pregunta datos de plata/trabajos. Ej: "cuánto le facturé a X", "qué me deben", "cuánto vendí este mes", "trabajos de X".\n`
    + `- nuevo_cheque: menciona un CHEQUE que recibió o entregó. Ej: "me dieron un cheque de andreu por 200 lucas a 30 días".\n`
    + `- ver_cheques: quiere ver los cheques pendientes. cheque_cobrado: un cheque ya se cobró/depositó ("cobré el cheque de X", "entró el cheque").\n`
    + `- nuevo_pago: un SERVICIO o gasto fijo a pagar (luz, gas, alquiler, internet, impuestos, proveedor). Ej: "hay que pagar la luz 30 lucas el viernes".\n`
    + `- ver_pagos: quiere ver los pagos pendientes. pago_hecho: ya pagó un servicio ("pagué la luz", "ya está el alquiler").\n`
    + `- nueva_compra: agregar un INSUMO/material a la lista de compras (tinta, vinilo, papel). Ej: "anotá que falta tinta negra".\n`
    + `- ver_compras: quiere ver la lista de compras. compra_hecha: ya compró un insumo ("compré la tinta", "ya traje los rollos").\n`
    + `- ayuda: no sabe qué puede hacer o pide instrucciones. Ej: "qué puedo hacer", "cómo funciona esto", "ayuda".\n`
    + `- ver_activos / ver_bandeja / ver_sin_presupuestar: pide ver esas listas. resumen: "cómo viene/menú/hola".\n`
    + `- confirmar/descartar: "ok/sí" o "no" a un borrador.\n\n`
    + `Distinguí bien: pagar un servicio/gasto (nuevo_pago) es distinto de comprar un insumo (nueva_compra). Un cheque siempre lleva la palabra cheque.\n`
    + `Reglas de cliente (usá las listas de arriba): empresa conocida => empresa; contacto conocido => persona; "X de Y" => contacto X, empresa Y; nombre suelto desconocido => contacto (individual), empresa "". Nunca pongas "cliente individual" como nombre; si no hay empresa, empresa: "".\n`
    + `Jerga: lucas=miles (80 lucas=80000), palo=millón, gamba=100.`;
}
function promptActualizar(texto, listaTxt) {
  return `El usuario quiere modificar un trabajo existente.${listaTxt ? ' Lista reciente: ' + listaTxt + '.' : ''}\nDijo: "${texto}".\n`
    + `Devolvé SOLO JSON:\n`
    + `- "ref_id": número si dice #N o un id, si no null.\n`
    + `- "ref_n": posición en la lista reciente si dice "el 1/2/3", si no null.\n`
    + `- "ref_cliente": nombre de cliente/empresa si se refiere por nombre ("el de andreu"), si no null.\n`
    + `- "estado": uno de [cotizar, presupuestado, pedido, en_progreso, en_espera, finalizado] si cambia el estado (terminó/entregó=finalizado, en espera=en_espera, empezó/haciendo=en_progreso), si no null.\n`
    + `- "pagado": true/false/null. "facturado": true/false/null.\n`
    + `- "precio": entero en pesos si menciona precio nuevo, si no null (lucas=miles).\n`
    + `- "disciplina": laser|serigrafia|ploteo|impresion si la cambia, si no null.`;
}
function promptConsulta(texto) {
  return `El usuario de un taller hace una consulta. Dijo: "${texto}".\nDevolvé SOLO JSON:\n`
    + `- "tipo": [facturado_cliente, por_cobrar, ventas_periodo, trabajos_cliente].\n`
    + `  facturado_cliente: cuánto se le facturó/vendió a un cliente. por_cobrar: cuánto deben / falta cobrar. ventas_periodo: cuánto se vendió en un período. trabajos_cliente: qué trabajos tiene un cliente.\n`
    + `- "cliente": nombre si lo menciona, si no null.\n`
    + `- "periodo": "hoy" | "semana" | "mes" | null.`;
}
function promptCheque(texto) {
  return `Hoy es ${hoyISO()}. El usuario registra un CHEQUE del taller. Dijo: "${texto}".\nDevolvé SOLO JSON:\n`
    + `- "tipo": "recibido" (se lo dan / le pagan con cheque) o "emitido" (él lo entrega para pagar).\n`
    + `- "modalidad": "electronico" si menciona e-check, echeck, cheque electrónico o digital; si no, "fisico" (cheque de papel).\n`
    + `- "importe": entero en pesos (lucas=miles, palo=millón, gamba=100), 0 si no dice.\n`
    + `- "banco": nombre del banco o null.\n`
    + `- "relacionado": nombre del cliente (si recibido) o proveedor (si emitido), o null.\n`
    + `- "fecha_cobro": fecha de cobro/vencimiento en formato YYYY-MM-DD, calculada desde hoy si dice "el viernes", "a 30 días", "el 15", "fin de mes"; null si no la menciona.`;
}
function promptPago(texto) {
  return `Hoy es ${hoyISO()}. El usuario registra un PAGO DE SERVICIO o gasto fijo del taller (luz, gas, agua, alquiler, internet, teléfono, impuestos, un proveedor). Dijo: "${texto}".\nDevolvé SOLO JSON:\n`
    + `- "concepto": qué se paga (ej: "luz", "alquiler", "internet"), en pocas palabras.\n`
    + `- "importe": entero en pesos (lucas=miles), 0 si no dice.\n`
    + `- "fecha_vencimiento": YYYY-MM-DD desde hoy si menciona vencimiento, si no null.`;
}
function promptCompra(texto) {
  return `El usuario agrega algo a la LISTA DE COMPRAS del taller (insumos/materiales: tinta, vinilo, papel, planchas, etc.). Dijo: "${texto}".\nDevolvé SOLO JSON:\n`
    + `- "item": qué hay que comprar, corto (ej: "tinta negra", "rollos de vinilo").\n`
    + `- "cantidad": texto libre si la menciona (ej: "2 rollos", "medio kilo"), si no null.`;
}
function promptNombre(texto, que) {
  return `El usuario dice que ${que}. Dijo: "${texto}".\nDevolvé SOLO JSON: "nombre" = el nombre, cliente, proveedor, concepto o insumo al que se refiere (o null si no lo dice).`;
}

router.post('/mensaje', async (req, res) => {
  const from = (req.body && req.body.from) || '';
  const texto = ((req.body && req.body.texto) || '').trim();
  if (!from) return res.status(400).json({ error: 'Falta from' });
  if (AUTORIZADOS.length && !AUTORIZADOS.includes(from)) return res.json({ reply: null, ignorado: true });

  const t = texto.toLowerCase();
  const ctx = await getCtx(from);
  const esOpcion = (n) => t === String(n) || t === n + ')' || t === n + '.';
  // Limpia valores basura que manda n8n en modo JSON ("null", "undefined", vacío).
  const limpio = (v) => { const s = (v == null ? '' : String(v)).trim(); return (!s || s === 'null' || s === 'undefined') ? null : s; };
  const mediaUrl = limpio(req.body && req.body.media_url);
  const mediaB64 = limpio(req.body && req.body.media_base64);
  const mime0 = limpio(req.body && req.body.mimetype);
  const tieneImagen = !!mediaB64 || (!!mediaUrl && /^https?:\/\//i.test(mediaUrl));

  // ---- Llegó una IMAGEN por WhatsApp ----
  if (tieneImagen) {
    let buf; let mime;
    try {
      if (mediaB64) { buf = Buffer.from(mediaB64, 'base64'); mime = mime0 || 'image/jpeg'; }
      else { const d = await bajarImagenWaha(mediaUrl); buf = d.buf; mime = mime0 || d.mime; }
    } catch (e) { console.error('img:', e.message); return res.json({ reply: '📎 Recibí una imagen pero no la pude descargar. Probá de nuevo en un ratito.' }); }
    const archivo = await guardarArchivo(buf, mime);
    let objetivo = await resolverObjetivo(texto, ctx);
    // Si no lo aclara en el texto, la pego al último borrador recién anotado (trabajo o cheque).
    if (!objetivo.id && ctx.datos && ctx.datos.pendiente && ctx.datos.pendiente.id && ctx.datos.pendiente.tipo !== 'pago') {
      objetivo = { tipo: ctx.datos.pendiente.tipo, id: ctx.datos.pendiente.id };
    }
    if (objetivo.id) {
      await adjuntar(objetivo.tipo, objetivo.id, archivo, mime, texto || null);
      return res.json({ reply: `📎 Guardé la foto en ${objetivo.tipo === 'cheque' ? 'el cheque' : 'el trabajo'} #${objetivo.id}${objetivo.nombre ? ` (${objetivo.nombre})` : ''}.` });
    }
    await setCtx(from, 'adjuntando', { archivo, mime });
    return res.json({ reply: '📎 Recibí la foto. ¿A qué la adjunto? Decime el número (ej: #5) o el nombre del cliente. Si es un cheque, aclarámelo (ej: "cheque de garcía").' });
  }

  // ---- Respuesta a "¿a qué adjunto la foto?" ----
  if (ctx.estado === 'adjuntando') {
    if (/^cancel/i.test(t) || esSalir(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: 'Listo, descarté la foto.' }); }
    const objetivo = await resolverObjetivo(texto, ctx);
    if (!objetivo.id) return res.json({ reply: 'No ubiqué a cuál. Decime el número (#5) o el nombre del cliente. (o "cancelar")' });
    await adjuntar(objetivo.tipo, objetivo.id, ctx.datos.archivo, ctx.datos.mime, null);
    await setCtx(from, 'idle', {});
    return res.json({ reply: `📎 Listo, foto guardada en ${objetivo.tipo === 'cheque' ? 'el cheque' : 'el trabajo'} #${objetivo.id}.` });
  }

  if (esSalir(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: '👍 Cuando quieras.' }); }
  if (esAyuda(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: ayudaTexto() }); }
  if (esSaludo(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: await menuTexto() }); }

  // Diálogo guiado de actualización (cuando pediste la lista)
  if (ctx.estado === 'eligiendo') {
    const lista = (ctx.datos && ctx.datos.lista) || [];
    const listaTxt = lista.map((x) => `${x.n}) #${x.id} ${x.cliente} ${x.descripcion || ''}`).join('; ');
    const d = await ollamaJSON(`Trabajos: ${listaTxt}.\nEl usuario dijo: "${texto}".\nDevolvé SOLO JSON: n (número de la lista o null), finalizado (true/null), pagado (true/false/null), facturado (true/false/null).`, SCHEMA.eligiendo);
    const item = lista.find((x) => x.n == d.n);
    if (!item) return res.json({ reply: 'No entendí a cuál. Decime el número, ej: "el 1 se terminó". (o "menu")' });
    await aplicar(item.id, { finalizado: d.finalizado === true, pagado: d.pagado, facturado: d.facturado });
    if (d.finalizado === true && d.pagado !== true && d.pagado !== false) { await setCtx(from, 'preg_cobro', { trabajo_id: item.id, n: item.n, facturado: d.facturado }); return res.json({ reply: `Anotado ✍️ ¿El ${item.n} (#${item.id}) quedó cobrado? (sí/no)` }); }
    if (d.finalizado === true && d.facturado !== true && d.facturado !== false) { await setCtx(from, 'preg_factura', { trabajo_id: item.id }); return res.json({ reply: '¿Y quedó facturado? (sí/no)' }); }
    await setCtx(from, 'idle', {}); return res.json({ reply: `✅ Listo #${item.id}.` });
  }
  if (ctx.estado === 'preg_cobro') {
    const v = esSi(t) ? true : esNo(t) ? false : null;
    if (v === null) return res.json({ reply: 'Respondé sí o no 🙂 ¿Quedó cobrado?' });
    await aplicar(ctx.datos.trabajo_id, { pagado: v });
    if (ctx.datos.facturado !== true && ctx.datos.facturado !== false) { await setCtx(from, 'preg_factura', { trabajo_id: ctx.datos.trabajo_id }); return res.json({ reply: '¿Y quedó facturado? (sí/no)' }); }
    await setCtx(from, 'idle', {}); return res.json({ reply: `✅ Listo #${ctx.datos.trabajo_id}.` });
  }
  if (ctx.estado === 'preg_factura') {
    const v = esSi(t) ? true : esNo(t) ? false : null;
    if (v === null) return res.json({ reply: 'Respondé sí o no. ¿Quedó facturado?' });
    await aplicar(ctx.datos.trabajo_id, { facturado: v });
    await setCtx(from, 'idle', {}); return res.json({ reply: `✅ Listo #${ctx.datos.trabajo_id}, actualizado.` });
  }

  // Atajo: "ok"/"no" sobre un borrador recién anotado → resolver sin llamar a la IA.
  if (ctx.datos && ctx.datos.pendiente && ctx.datos.pendiente.id && (esSi(t) || esNo(t))) {
    const pend = ctx.datos.pendiente;
    const accion = esSi(t) ? 'confirmar' : 'descartar';
    const r = await confirmarEntidad(pend.tipo, accion, pend.id);
    await setCtx(from, 'idle', {});
    const et = pend.tipo === 'cheque' ? 'Cheque' : pend.tipo === 'pago' ? 'Pago' : 'Trabajo';
    if (!r) return res.json({ reply: 'No había nada pendiente.' });
    return res.json({ reply: accion === 'descartar' ? `🗑 ${et} descartado.` : `✅ ${et} confirmado.` });
  }

  if (esOpcion(1)) return res.json({ reply: await listarActivos(from) });
  if (esOpcion(2)) return res.json({ reply: await listarBandeja() });
  if (esOpcion(3)) return res.json({ reply: await listarSinPresup() });

  // Router con contexto
  const ctxNegocio = await contextoClientes();
  const d = await ollamaJSON(promptClasificar(texto, ctxNegocio), SCHEMA.clasificar);
  if (!d || Object.keys(d).length === 0) return res.json({ reply: '🤖 Uy, no te pude procesar (la IA no respondió). ¿Me lo repetís?' });
  const intent = d.intencion || 'nuevo_trabajo';
  const idMenc = d.id || (texto.match(/#?(\d{1,6})/) ? Number(texto.match(/#?(\d{1,6})/)[1]) : null);

  if (intent === 'ver_activos') return res.json({ reply: await listarActivos(from) });
  if (intent === 'ver_bandeja') return res.json({ reply: await listarBandeja() });
  if (intent === 'ver_sin_presupuestar') return res.json({ reply: await listarSinPresup() });
  if (intent === 'resumen') return res.json({ reply: await menuTexto() });
  if (intent === 'ayuda') return res.json({ reply: ayudaTexto() });
  if (intent === 'confirmar' || intent === 'descartar') {
    const pend = ctx.datos && ctx.datos.pendiente;
    const etiqueta = (tp) => tp === 'cheque' ? 'Cheque' : tp === 'pago' ? 'Pago' : 'Trabajo';
    // 1) Algo recién anotado y sin #id → actuar sobre eso.
    if (pend && pend.id && !idMenc) {
      const r = await confirmarEntidad(pend.tipo, intent, pend.id);
      await setCtx(from, 'idle', {});
      if (!r) return res.json({ reply: 'No había nada pendiente para confirmar.' });
      return res.json({ reply: r.accion === 'descartado' ? `🗑 ${etiqueta(pend.tipo)} descartado.` : `✅ ${etiqueta(pend.tipo)} confirmado.` });
    }
    // 2) Con #id → buscar el borrador en trabajos, cheques o pagos.
    if (idMenc) {
      for (const tp of ['trabajo', 'cheque', 'pago']) {
        const tabla = tp === 'cheque' ? 'cheques' : tp === 'pago' ? 'pagos_servicios' : 'trabajos';
        const hay = await query(`SELECT 1 FROM ${tabla} WHERE id = $1 AND revisado = FALSE`, [idMenc]);
        if (hay.rows.length) {
          const r = await confirmarEntidad(tp, intent, idMenc);
          await setCtx(from, 'idle', {});
          return res.json({ reply: r.accion === 'descartado' ? `🗑 ${etiqueta(tp)} #${idMenc} descartado.` : `✅ ${etiqueta(tp)} #${idMenc} confirmado.` });
        }
      }
      return res.json({ reply: `No encontré el borrador #${idMenc}.` });
    }
    // 3) Fallback: último borrador de trabajo.
    const r = await confirmarBorrador(intent, null);
    if (!r) return res.json({ reply: 'No hay borradores pendientes. Mandame un pedido o preguntame qué tenés.' });
    return res.json({ reply: r.accion === 'descartado' ? `🗑 Descartado #${r.id}` : `✅ Confirmado #${r.id} (${r.cliente})` });
  }

  if (intent === 'consulta') {
    const q = await ollamaJSON(promptConsulta(texto), SCHEMA.consulta);
    return res.json({ reply: await responderConsulta(q) });
  }

  if (intent === 'actualizar_trabajo') {
    const lista = (ctx.datos && ctx.datos.lista) || [];
    const listaTxt = lista.map((x) => `${x.n}) #${x.id} ${x.cliente}`).join('; ');
    const u = await ollamaJSON(promptActualizar(texto, listaTxt), SCHEMA.actualizar);
    const ref = await resolverRef(u, ctx);
    if (ref.multiple) return res.json({ reply: `Hay varios de "${u.ref_cliente}": ${ref.multiple.map((x) => '#' + x).join(', ')}. ¿Cuál? Decime el #número.` });
    if (!ref.id) return res.json({ reply: 'No supe a qué trabajo te referís. Decime el #número o el nombre del cliente.' });
    const cambios = {};
    if (ESTADOS.includes(u.estado)) cambios.estado = u.estado;
    if (u.pagado === true || u.pagado === false) cambios.pagado = u.pagado;
    if (u.facturado === true || u.facturado === false) cambios.facturado = u.facturado;
    if (typeof u.precio === 'number' && u.precio > 0) cambios.precio = u.precio;
    if (DISCIPLINAS.includes(u.disciplina)) cambios.disciplina = u.disciplina;
    const tr = await aplicar(ref.id, cambios);
    if (!tr) return res.json({ reply: 'No entendí qué cambiar. Ej: "poné el 3 en espera" o "el de Andreu se cobró".' });
    const partes = [];
    if (cambios.estado) partes.push(LBL_ESTADO[cambios.estado]);
    if (cambios.pagado === true) partes.push('cobrado'); if (cambios.pagado === false) partes.push('sin cobrar');
    if (cambios.facturado === true) partes.push('facturado'); if (cambios.facturado === false) partes.push('sin facturar');
    if (cambios.precio) partes.push(money(cambios.precio));
    if (cambios.disciplina) partes.push(cambios.disciplina);
    return res.json({ reply: `✅ #${tr.id} ${tr.cliente}: ${partes.join(', ') || 'actualizado'}.` });
  }

  // ----- Cheques -----
  if (intent === 'ver_cheques') return res.json({ reply: await listarCheques() });
  if (intent === 'nuevo_cheque') {
    const c = await ollamaJSON(promptCheque(texto), SCHEMA.cheque);
    const ch = await crearCheque(c);
    await setCtx(from, 'idle', { pendiente: { tipo: 'cheque', id: ch.id } });
    return res.json({ reply: `🧾 Anoté un cheque${ch.modalidad === 'electronico' ? ' electrónico (e-check)' : ''} ${ch.tipo === 'recibido' ? 'a cobrar de' : 'a pagar a'} ${ch.relacionado || '—'} ${money(ch.importe)}${ch.fecha_cobro ? `, ${fmtFecha(ch.fecha_cobro)}` : ''}.\nRespondé "ok" para confirmarlo o "no" para descartarlo.` });
  }
  if (intent === 'cheque_cobrado') {
    const r = await ollamaJSON(promptNombre(texto, 'cobró un cheque'), SCHEMA.refNombre);
    const ch = await marcarChequeCobrado(r.nombre);
    return res.json({ reply: ch ? `✅ Cheque de ${ch.relacionado || '—'} ${money(ch.importe)} marcado como cobrado.` : 'No encontré ese cheque pendiente. Escribí "ver cheques".' });
  }

  // ----- Pagos de servicios -----
  if (intent === 'ver_pagos') return res.json({ reply: await listarPagos() });
  if (intent === 'nuevo_pago') {
    const p = await ollamaJSON(promptPago(texto), SCHEMA.pago);
    const pg = await crearPago(p);
    return res.json({ reply: `💡 Pago anotado: ${pg.concepto} ${money(pg.importe)}${pg.fecha_vencimiento ? `, vence ${fmtFecha(pg.fecha_vencimiento)}` : ''}.` });
  }
  if (intent === 'pago_hecho') {
    const r = await ollamaJSON(promptNombre(texto, 'pagó un servicio o gasto'), SCHEMA.refNombre);
    const pg = await marcarPagoHecho(r.nombre);
    return res.json({ reply: pg ? `✅ ${pg.concepto} ${money(pg.importe)} marcado como pagado.` : 'No encontré ese pago pendiente. Escribí "ver pagos".' });
  }

  // ----- Lista de compras -----
  if (intent === 'ver_compras') return res.json({ reply: await listarCompras() });
  if (intent === 'nueva_compra') {
    const c = await ollamaJSON(promptCompra(texto), SCHEMA.compra);
    const cp = await crearCompra(c);
    return res.json({ reply: `🛒 Agregado a la lista: ${cp.item}${cp.cantidad ? ` (${cp.cantidad})` : ''}.` });
  }
  if (intent === 'compra_hecha') {
    const r = await ollamaJSON(promptNombre(texto, 'ya compró un insumo'), SCHEMA.refNombre);
    const cp = await marcarCompraHecha(r.nombre);
    return res.json({ reply: cp ? `✅ Tachado de la lista: ${cp.item}.` : 'No encontré ese ítem en la lista. Escribí "ver compras".' });
  }

  // nuevo_trabajo (o fallback)
  const tr = await crearBorradorDesde(d);
  await setCtx(from, 'idle', { pendiente: { tipo: 'trabajo', id: tr.id } });
  return res.json({ reply: `🆕 Anoté #${tr.id}: ${tr.cliente} — ${tr.descripcion || ''} — ${money(tr.precio)}. Respondé "ok" para confirmar o "no" para descartar.` });
});

router.get('/nudge', async (req, res) => {
  const to = (req.query.to || '').trim();
  if (to) await setCtx(to, 'idle', {});
  res.json({ reply: await nudgeTexto() });
});

export default router;

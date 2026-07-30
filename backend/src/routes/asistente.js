import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, audit } from '../db.js';
import { requiereIngest } from '../auth.js';
import { resolverEmpresa, resolverContacto } from '../resolvers.js';
import { DISCIPLINAS, ESTADOS } from '../constantes.js';

const router = Router();
router.use(requiereIngest);

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const WAHA_URL = process.env.WAHA_URL || 'http://host.docker.internal:3001';
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b';
// keep_alive: cuánto queda el modelo cargado en la GPU después del último mensaje.
// 30m = balance: rápido en conversación, y libera la VRAM cuando nadie usa el asistente.
// Subilo (ej: '24h') si la GPU es dedicada, bajalo (ej: '5m') si la usás mucho para otra cosa.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
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
      intencion: { type: 'string', enum: ['nuevo_trabajo', 'actualizar_trabajo', 'consulta', 'ver_activos', 'ver_bandeja', 'ver_sin_presupuestar', 'resumen', 'confirmar', 'descartar', 'nuevo_cheque', 'ver_cheques', 'cheque_cobrado', 'nuevo_pago', 'ver_pagos', 'pago_hecho', 'nueva_compra', 'ver_compras', 'compra_hecha', 'cotizar', 'ver_precios', 'ayuda', 'nada'] },
      confianza: { type: 'string', enum: ['alta', 'baja'] },
      id: NUL('integer'), empresa: NUL('string'), contacto: NUL('string'),
      descripcion: NUL('string'), disciplina: NUL('string'), precio: NUL('integer'),
      item: NUL('string'), cantidad: NUL('integer'), m2: NUL('number'), horas: NUL('number'),
    },
    required: ['intencion', 'confianza'],
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
  corregirCheque: {
    type: 'object',
    properties: {
      corrige: { type: 'boolean' },
      tipo: NUL('string'), modalidad: NUL('string'), importe: NUL('integer'),
      banco: NUL('string'), relacionado: NUL('string'), fecha_cobro: NUL('string'),
    },
    required: ['corrige', 'tipo', 'modalidad', 'importe', 'banco', 'relacionado', 'fecha_cobro'],
  },
  corregirTrabajo: {
    type: 'object',
    properties: {
      corrige: { type: 'boolean' },
      empresa: NUL('string'), contacto: NUL('string'), descripcion: NUL('string'),
      disciplina: NUL('string'), precio: NUL('integer'),
    },
    required: ['corrige', 'empresa', 'contacto', 'descripcion', 'disciplina', 'precio'],
  },
};

const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 120000;
async function ollamaJSON(prompt, schema) {
  try {
    // Timeout generoso: el primer mensaje tras un rato de inactividad paga la carga
    // del modelo a la GPU (30-60s). Pasado el límite, cortamos y avisamos.
    const r = await fetch(OLLAMA_URL + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, think: false, keep_alive: OLLAMA_KEEP_ALIVE, format: schema || 'json', options: { temperature: 0 } }),
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

// Guarda "de qué estábamos hablando" SIN pisar el resto del contexto (pendiente, lista...).
// Es lo que le permite entender respuestas cortas: "mostrámelos", "cuáles", "dale".
async function setUltimo(chatId, tema, extra) {
  if (!chatId) return;
  const ctx = await getCtx(chatId);
  await setCtx(chatId, ctx.estado || 'idle', { ...(ctx.datos || {}), ultimo: tema, ...(extra || {}) });
}

// Texto normalizado: sin acentos, sin puntuación, en minúsculas. Para comparar sin sorpresas.
const normTxt = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

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
// Menú NUMERADO: el usuario contesta "4" y sabe exactamente qué va a recibir.
// Cada opción trae su cantidad de pendientes, así el menú ya informa por sí solo.
const OPCIONES = { 1: 'trabajos', 2: 'bandeja', 3: 'sin_presupuestar', 4: 'cheques', 5: 'pagos', 6: 'compras', 7: 'precios' };
async function menuOpciones() {
  const c = await contar();
  const uno = async (sql) => Number((await query(sql)).rows[0].n) || 0;
  const chq = await uno(`SELECT COUNT(*)::int n FROM cheques WHERE estado='pendiente'`);
  const pag = await uno(`SELECT COUNT(*)::int n FROM pagos_servicios WHERE estado='pendiente'`);
  const comp = await uno(`SELECT COUNT(*)::int n FROM lista_compras WHERE NOT comprado`);
  const pre = await uno(`SELECT COUNT(*)::int n FROM precios WHERE activo`);
  return `1) Trabajos en curso (${c.activos})\n`
    + `2) Bandeja sin confirmar (${c.bandeja})\n`
    + `3) Sin presupuestar (${c.sin_presup})\n`
    + `4) Cheques pendientes (${chq})\n`
    + `5) Pagos por vencer (${pag})\n`
    + `6) Lista de compras (${comp})\n`
    + `7) Lista de precios (${pre})`;
}
async function menuTexto(chatId) {
  const ops = await menuOpciones();
  if (chatId) await setUltimo(chatId, 'menu');
  return `🤖 ¿Qué querés ver? Contestame con el número:\n\n${ops}\n\n`
    + `O hablame normal: "ramiro quiere 100 remeras a 80 lucas", "cuánto salen 100 remeras", "cobré el cheque de andreu".`;
}
// Respuesta cuando NO entendimos. Lo importante: avisa que no guardó nada y ofrece
// salidas concretas. Antes, cualquier mensaje raro terminaba creando un trabajo fantasma.
async function noEntendi(chatId) {
  const ops = await menuOpciones();
  if (chatId) await setUltimo(chatId, 'menu');
  return `🤔 No te entendí, así que no anoté nada. Contestame con un número:\n\n${ops}\n\n`
    + `O decime algo concreto, por ejemplo:\n`
    + `• "ramiro quiere 100 remeras a 80 lucas"\n`
    + `• "cuánto salen 100 remeras"\n`
    + `• "cobré el cheque de andreu"\n`
    + `• "el 3 se terminó y se cobró"`;
}
// Resuelve una opción del menú, o un "mostrámelos" que apunta al tema anterior.
async function mostrarTema(chatId, tema) {
  if (tema === 'trabajos') return listarActivos(chatId);
  if (tema === 'bandeja') return listarBandeja();
  if (tema === 'sin_presupuestar') return listarSinPresup();
  if (tema === 'cheques') return listarCheques(null);
  if (tema === 'pagos') return listarPagos();
  if (tema === 'compras') return listarCompras();
  if (tema === 'precios') return textoListaPrecios();
  return null;
}
// Frases deícticas sueltas: piden ver "eso" de lo que veníamos hablando.
// Se testean contra el texto normalizado (sin acentos ni signos).
const RE_MOSTRAR = /^(dale\s+)?(y\s+)?(bueno\s+)?(a ver|ver|verlos|verlas|mostra|mostrame|mostramelo|mostramelos|mostramela|mostramelas|mostralo|mostralos|mostrala|mostralas|pasame|pasamelos|pasamelas|dame|damelos|cual|cuales|esos|esas|eso|los|las|cuales son|mostra la lista)$/;
// Guardia anti-fantasmas: solo damos por hecho que es un pedido nuevo si hay
// cliente REAL + descripción + una frase de verdad. "mostramelo" ya no es un trabajo.
const RE_NO_CLIENTE = /^(mostrame|mostramelo|mostramelos|mostramela|mostramelas|mostralo|mostralos|dale|ok|oka|eso|esos|esas|si|no|cual|cuales|menu|hola|buenas|gracias|listo|ver|a ver|pasame|dame|nada|cliente|cliente individual|individual|sin nombre|el|la|los|las)$/;
function pareceTrabajo(texto, d) {
  const emp = (d && d.empresa ? String(d.empresa) : '').trim();
  const con = (d && d.contacto ? String(d.contacto) : '').trim();
  const creibles = [emp, con].filter(Boolean).filter((x) => !RE_NO_CLIENTE.test(normTxt(x)));
  if (!creibles.length) return false;                                     // sin cliente creíble
  if (!(d.descripcion && String(d.descripcion).trim())) return false;     // sin qué hacer
  if (normTxt(texto).split(' ').filter(Boolean).length < 3) return false; // dos palabras no son un pedido
  return true;
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
    + `💲 *PRECIOS*\n`
    + `• Cotizar: "cuánto salen 100 remeras", "precio de 3 m2 de vinilo"\n`
    + `• Ver todo: "lista de precios"\n`
    + `• Después de cotizar: "anotalo para andreu" y te lo cargo como trabajo\n\n`
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

// ---- Correcciones sobre un borrador que espera confirmación ----
async function aplicarCorreccionCheque(id, c) {
  const sets = []; const vals = [];
  const put = (campo, v) => { vals.push(v); sets.push(`${campo} = $${vals.length}`); };
  if (c.tipo === 'recibido' || c.tipo === 'emitido') put('tipo', c.tipo);
  if (c.modalidad === 'fisico' || c.modalidad === 'electronico') put('modalidad', c.modalidad);
  if (typeof c.importe === 'number' && c.importe > 0) put('importe', c.importe);
  if (c.banco) put('banco', c.banco);
  if (c.relacionado) put('relacionado', c.relacionado);
  if (fechaValida(c.fecha_cobro)) put('fecha_cobro', c.fecha_cobro);
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await query(`UPDATE cheques SET ${sets.join(', ')} WHERE id = $${vals.length} AND revisado = FALSE RETURNING *`, vals);
  if (rows[0]) await audit(null, 'corregir', 'cheque', id, c);
  return rows[0];
}
async function aplicarCorreccionTrabajo(id, c) {
  const sets = []; const vals = [];
  const put = (campo, v) => { vals.push(v); sets.push(`${campo} = $${vals.length}`); };
  if (c.descripcion) put('descripcion', c.descripcion);
  if (DISCIPLINAS.includes(c.disciplina)) put('disciplina', c.disciplina);
  if (typeof c.precio === 'number' && c.precio > 0) put('precio', c.precio);
  if ((c.contacto && c.contacto.trim()) || (c.empresa && c.empresa.trim())) {
    const empresaId = (c.empresa && c.empresa.trim()) ? await resolverEmpresa(c.empresa.trim(), 'ia') : null;
    const contactoId = (c.contacto && c.contacto.trim()) ? await resolverContacto(c.contacto.trim(), empresaId, 'ia') : null;
    const cliente = (c.contacto && c.contacto.trim())
      ? (c.contacto.trim() + (c.empresa && c.empresa.trim() ? ` (${c.empresa.trim()})` : ''))
      : c.empresa.trim();
    if (empresaId) put('empresa_id', empresaId);
    if (contactoId) put('contacto_id', contactoId);
    put('cliente', cliente);
  }
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await query(`UPDATE trabajos SET ${sets.join(', ')}, actualizado_en = now() WHERE id = $${vals.length} AND revisado = FALSE RETURNING *`, vals);
  if (rows[0]) await audit(null, 'corregir', 'trabajo', id, c);
  return rows[0];
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
    return `📋 TRABAJOS por cobrar: ${money(rows[0].total)} (${rows[0].n} finalizados sin cobrar).\n(Si querías cheques, decí "ver cheques".)`;
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
async function listarCheques(filtro) {
  const cond = filtro === 'emitido' ? " AND tipo='emitido'" : filtro === 'recibido' ? " AND tipo='recibido'" : '';
  const { rows } = await query(`SELECT id, tipo, importe, relacionado, fecha_cobro FROM cheques WHERE estado='pendiente'${cond} ORDER BY fecha_cobro NULLS LAST, id LIMIT 12`);
  if (!rows.length) {
    return filtro === 'emitido' ? 'No hay cheques por pagar 👍'
      : filtro === 'recibido' ? 'No hay cheques por cobrar 👍'
      : 'No hay cheques pendientes 👍';
  }
  const titulo = filtro === 'emitido' ? '🧾 Cheques por pagar (emitidos)'
    : filtro === 'recibido' ? '🧾 Cheques por cobrar (recibidos)'
    : '🧾 Cheques pendientes';
  const total = rows.reduce((a, r) => a + Number(r.importe || 0), 0);
  return `${titulo} — ${rows.length} por ${money(total)}:\n` + rows.map((r) => `#${r.id} ${r.tipo === 'recibido' ? 'a cobrar de' : 'a pagar a'} ${r.relacionado || '—'} ${money(r.importe)}${r.fecha_cobro ? ` (${fmtFecha(r.fecha_cobro)})` : ''}`).join('\n') + '\n\nDecime "cobré el cheque de X" cuando entre.';
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

// ---- Lista de precios y cotizador ----
// Espeja la calculadora de la web: p50/p100/p250/p500 son precios POR UNIDAD
// según la escala, y precio es el valor por m² o por hora.
const ESCALAS = [
  { min: 500, campo: 'p500' }, { min: 250, campo: 'p250' },
  { min: 100, campo: 'p100' }, { min: 50, campo: 'p50' },
];
const LBL_RUBRO = { serigrafia: 'Serigrafía', laser: 'Grabado láser', impresion: 'Impresión', ploteo: 'Ploteo', diseno: 'Diseño' };
const RUBRO_DISC = { serigrafia: 'serigrafia', laser: 'laser', ploteo: 'ploteo', impresion: 'impresion', diseno: 'impresion' };
// "remeras" -> "remera", "papeles" -> "papel": empareja singular/plural sin diccionario.
const singular = (w) => (w.length > 3 && /s$/.test(w) ? w.replace(/es$/, '').replace(/s$/, '') : w);
// Cuánto del NOMBRE del ítem aparece en la consulta (0 a 1).
function puntajeItem(nombre, consulta) {
  const a = normTxt(nombre).split(' ').map(singular).filter((w) => w.length > 2);
  const b = normTxt(consulta).split(' ').map(singular).filter((w) => w.length > 2);
  if (!a.length || !b.length) return 0;
  let hit = 0;
  for (const w of a) if (b.some((x) => x === w || x.includes(w) || w.includes(x))) hit++;
  return hit / a.length;
}
function candidatosItem(rows, consulta) {
  return rows.map((it) => ({ it, p: puntajeItem(it.nombre, consulta) }))
    .filter((x) => x.p >= 0.5).sort((a, b) => b.p - a.p);
}
// Tramo de precio que corresponde a esa cantidad: el más alto que no la supere.
// Si pide menos que el tramo más chico cargado, se usa ese (no regalamos el trabajo).
function escalaInfo(it, cant) {
  const tramos = ESCALAS.filter((e) => Number(it[e.campo]) > 0);
  if (!tramos.length) return null;
  const elegido = tramos.find((e) => cant >= e.min) || tramos[tramos.length - 1];
  return { unitario: Number(it[elegido.campo]), desde: elegido.min };
}
async function itemsPrecios() {
  const { rows } = await query('SELECT * FROM precios WHERE activo ORDER BY rubro, nombre');
  return rows;
}
async function textoListaPrecios() {
  const rows = await itemsPrecios();
  if (!rows.length) return '💲 Todavía no hay nada en la lista de precios. Cargala en la web (pestaña Precios) y después preguntame "cuánto salen 100 remeras".';
  const porRubro = {};
  for (const r of rows) (porRubro[r.rubro] = porRubro[r.rubro] || []).push(r);
  const bloques = Object.keys(porRubro).map((rb) => {
    const lineas = porRubro[rb].map((it) => {
      if (it.modo === 'por_m2') return `• ${it.nombre}: ${money(it.precio)} el m²`;
      if (it.modo === 'por_hora') return `• ${it.nombre}: ${money(it.precio)} la hora`;
      const esc = ESCALAS.filter((e) => Number(it[e.campo]) > 0)
        .map((e) => `${e.min}+ ${money(it[e.campo])}`).reverse().join(' · ');
      return `• ${it.nombre} (c/u): ${esc || 'sin precios cargados'}`;
    });
    return `*${LBL_RUBRO[rb] || rb}*\n` + lineas.join('\n');
  });
  return '💲 Lista de precios:\n\n' + bloques.join('\n\n') + '\n\nPreguntame, ej: "cuánto salen 100 remeras".';
}
async function renderCotiza(from, it, cant, unidad, unitario, desde) {
  if (!(unitario > 0)) return `${it.nombre} no tiene precio cargado. Cargalo en la web (pestaña Precios) y te lo calculo.`;
  const etiqueta = unidad === 'u' ? 'c/u' : unidad === 'hs' ? 'la hora' : 'el m²';
  const cantTxt = unidad === 'u' ? `${cant} u` : unidad === 'hs' ? `${cant} hs` : `${cant} m²`;
  const total = Math.round(unitario * cant);
  const L = [`💲 ${it.nombre} — ${cantTxt}`];
  L.push(`Unitario: ${money(unitario)} ${etiqueta}${desde ? ` (escala ${desde}+)` : ''}`);
  L.push(`Total: *${money(total)}*  ·  con IVA: ${money(Math.round(total * 1.21))}`);
  const costo = Number(it.costo) || 0;
  if (costo > 0) {
    const cTotal = Math.round(costo * cant);
    L.push(`Te sale ${money(cTotal)} · margen ${Math.round(((total - cTotal) / total) * 100)}%`);
  }
  if (it.notas) L.push(`📝 ${it.notas}`);
  L.push('\nSi va, decime "anotalo para <cliente>" y lo cargo como trabajo.');
  const ctx = await getCtx(from);
  const datos = { ...(ctx.datos || {}) };
  delete datos.pendiente;   // cambiamos de tema: un "ok" ahora es sobre la cotización
  await setCtx(from, 'idle', {
    ...datos, ultimo: 'cotizacion',
    cotizacion: { item_id: it.id, nombre: it.nombre, rubro: it.rubro, cant, unidad, unitario, total },
  });
  return L.join('\n');
}
async function cotizarItem(from, it, cant) {
  if (!(cant > 0)) return 'Necesito la cantidad. ¿Cuántos?';
  if (it.modo === 'por_m2') return renderCotiza(from, it, cant, 'm²', Number(it.precio) || 0);
  if (it.modo === 'por_hora') return renderCotiza(from, it, cant, 'hs', Number(it.precio) || 0);
  const esc = escalaInfo(it, cant);
  if (!esc) return `${it.nombre} no tiene precios por escala cargados. Cargalos en la web (pestaña Precios).`;
  return renderCotiza(from, it, cant, 'u', esc.unitario, esc.desde);
}
async function cotizarTexto(from, d, texto) {
  const rows = await itemsPrecios();
  if (!rows.length) return '💲 Todavía no cargaste la lista de precios. Metela en la web (pestaña Precios) y después preguntame "cuánto salen 100 remeras".';
  const cand = candidatosItem(rows, [d && d.item, texto].filter(Boolean).join(' '));
  if (!cand.length) {
    return `No encontré ese ítem en la lista. Tengo: ${rows.map((r) => r.nombre).join(', ')}.\n`
      + `Probá: "cuánto salen 100 ${String(rows[0].nombre).toLowerCase()}".`;
  }
  const empate = cand.filter((x) => x.p === cand[0].p);
  if (empate.length > 1) return `¿Cuál de estos? ${empate.map((x) => x.it.nombre).join(' / ')}. Repetime la pregunta con el nombre exacto.`;
  const it = cand[0].it;
  const nums = (String(texto).match(/\d+(?:[.,]\d+)?/g) || []).map((s) => Number(s.replace(',', '.')));
  let cant = 0;
  if (it.modo === 'por_m2') cant = Number(d && d.m2) || nums[0] || 0;
  else if (it.modo === 'por_hora') cant = Number(d && d.horas) || nums[0] || 0;
  else cant = Number(d && d.cantidad) || nums[0] || 0;
  if (!(cant > 0)) {
    const preg = it.modo === 'por_m2' ? '¿Cuántos m²?' : it.modo === 'por_hora' ? '¿Cuántas horas?' : '¿Cuántas unidades?';
    const ctx = await getCtx(from);
    await setCtx(from, 'cotizando', { ...(ctx.datos || {}), cotiza_item: it.id });
    return `${it.nombre}: ${preg} (decime solo el número)`;
  }
  return cotizarItem(from, it, cant);
}
// "anotalo para Andreu" después de una cotización: crea el borrador con cantidad y unitario.
const RE_ANOTAR = /\b(anotal[oa]|anota|anotame|cargal[oa]|carga|guardal[oa]|guarda|meteme|metel[oa])\b/i;
async function anotarCotizacion(from, ctx, texto) {
  const co = ctx.datos && ctx.datos.cotizacion;
  if (!co) return null;
  const m = String(texto).match(/\bpara\s+(.{2,60})$/i);
  const nombre = m ? m[1].trim().replace(/[.!?,;]+$/, '') : '';
  if (!nombre) return '¿Para qué cliente lo anoto? Decime "anotalo para <nombre>".';
  const e = await query("SELECT nombre FROM empresas WHERE nombre ILIKE $1 LIMIT 1", [nombre]);
  const campos = e.rows[0] ? { empresa: e.rows[0].nombre, contacto: null } : { empresa: null, contacto: nombre };
  const desc = co.unidad === 'u' ? `${co.cant} x ${co.nombre}` : `${co.cant} ${co.unidad} de ${co.nombre}`;
  const tr = await crearBorradorDesde({ ...campos, descripcion: desc, disciplina: RUBRO_DISC[co.rubro] || 'impresion', precio: co.total });
  await query('UPDATE trabajos SET cantidad = $1, precio_unitario = $2 WHERE id = $3', [co.cant, co.unitario, tr.id]);
  await setCtx(from, 'confirmando', { pendiente: { tipo: 'trabajo', id: tr.id, texto }, ultimo: 'bandeja' });
  return `🆕 Anoté #${tr.id}: ${tr.cliente} — ${desc} — ${money(co.total)} (${money(co.unitario)} c/u).\nRespondé "ok" para confirmar, "no" para descartar.`;
}

// ---- Secretario proactivo: resumen de pendientes ----
async function nudgeTexto() {
  const c = await contar();
  const q = async (sql) => (await query(sql)).rows[0];
  const chq = await q(`SELECT COUNT(*)::int n, COALESCE(SUM(importe),0) t FROM cheques WHERE estado='pendiente' AND fecha_cobro IS NOT NULL AND fecha_cobro <= CURRENT_DATE + INTERVAL '5 days'`);
  const pag = await q(`SELECT COUNT(*)::int n FROM pagos_servicios WHERE estado='pendiente' AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '5 days'`);
  const esp = await q(`SELECT COUNT(*)::int n FROM trabajos WHERE estado='en_espera' AND revisado`);
  const comp = await q(`SELECT COUNT(*)::int n FROM lista_compras WHERE NOT comprado`);
  // Solo lo que REQUIERE acción. Si esta lista queda vacía, no mandamos nada:
  // el recordatorio de las 9 y las 22 no tiene que ser ruido de fondo.
  const pend = [];
  if (c.bandeja) pend.push(`• ${c.bandeja} en la bandeja sin confirmar`);
  if (c.sin_presup) pend.push(`• ${c.sin_presup} sin presupuestar`);
  if (chq.n) pend.push(`• ${chq.n} cheque(s) por cobrar pronto (${money(chq.t)})`);
  if (pag.n) pend.push(`• ${pag.n} pago(s) por vencer`);
  if (esp.n) pend.push(`• ${esp.n} trabajo(s) frenados en espera`);
  if (comp.n) pend.push(`• 🛒 ${comp.n} cosa(s) en la lista de compras`);
  if (!pend.length) return null;   // todo al día: silencio
  let hora = 9;
  try {
    hora = Number(new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hourCycle: 'h23' }).format(new Date())) || 0;
  } catch { hora = new Date().getHours(); }
  const manana = hora < 14;
  const L = [manana ? '☀️ Buen día. Para arrancar:' : '🌙 Cierre del día. Quedó pendiente:'];
  L.push(...pend);
  if (c.activos) L.push(`• ${c.activos} trabajo(s) en curso`);
  L.push(manana ? '\n¿Arrancamos por alguno? Contame y lo actualizo. 👍' : '\n¿Algo avanzó o cobraste hoy? Contame y lo actualizo. 👍');
  return L.join('\n');
}

// ---- Imágenes / adjuntos que llegan por WhatsApp ----
async function bajarImagenWaha(mediaUrl) {
  // La URL que da WAHA apunta a su propio host (localhost:3000). Reescribimos SOLO el scheme+host
  // para alcanzar WAHA desde el contenedor, con un reemplazo de texto (no rompe si WAHA_URL es rara).
  let base = (WAHA_URL || '').trim().split(/\s/)[0];   // corta basura tras un espacio (env mal cargada)
  if (base && !/^https?:\/\//i.test(base)) base = 'http://' + base;
  // localhost/127.0.0.1 adentro del contenedor NO es WAHA (es la app): forzar host-gateway.
  if (!base || /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(base)) base = 'http://host.docker.internal:3001';
  base = base.replace(/\/+$/, '');
  const url = mediaUrl.replace(/^https?:\/\/[^/]+/i, base);
  // Reintenta: WAHA puede tardar ~1s en terminar de guardar el archivo tras avisar por webhook.
  let ultimo = 0;
  for (let intento = 0; intento < 6; intento++) {
    const r = await fetch(url, { headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {} });
    if (r.ok) {
      const mime = r.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await r.arrayBuffer());
      return { buf, mime };
    }
    ultimo = r.status;
    if (r.status !== 404) break;                         // otro error: no tiene sentido reintentar
    await new Promise((res) => setTimeout(res, 800));    // el archivo puede no estar listo todavía
  }
  console.error('img url fallida:', JSON.stringify(mediaUrl), '=>', url, 'status', ultimo);
  throw new Error('WAHA media ' + ultimo);
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
    + `- "confianza": "alta" si estás seguro; "baja" si el mensaje es corto, vago o ambiguo.\n`
    + `- "id": número de trabajo si menciona uno (#5), si no null.\n`
    + `- si es nuevo_trabajo: "empresa", "contacto", "descripcion", "disciplina" (laser|serigrafia|ploteo|impresion), "precio" (entero, 0 si no hay). impresion = tarjetería, lonas, fotocopias, folletería y afines.\n`
    + `- si es cotizar: "item" (qué producto pregunta, ej "remeras"), "cantidad" (entero) o "m2" o "horas" según corresponda; lo que no diga, null.\n\n`
    + `Cómo elegir la intención:\n`
    + `- nuevo_trabajo: encarga un TRABAJO por primera vez (cliente + cantidad/producto). Ej: "ramiro quiere 100 volantes".\n`
    + `- actualizar_trabajo: cambio sobre un trabajo YA existente (se terminó/cobró/facturó, cambiar estado/precio/disciplina, presupuestar). Ej: "el de andreu se entregó", "poné el 3 en espera", "presupuestá el 5 en 40 lucas".\n`
    + `- consulta: pregunta datos de plata/trabajos. Ej: "cuánto le facturé a X", "qué me deben", "cuánto vendí este mes", "trabajos de X".\n`
    + `- nuevo_cheque: menciona un CHEQUE que recibió o entregó. Ej: "me dieron un cheque de andreu por 200 lucas a 30 días".\n`
    + `- ver_cheques: pregunta por CHEQUES pendientes, en cualquier dirección. Ej: "¿hay cheques por pagar?", "¿qué cheques hay que pagar?", "¿qué cheques entran?", "¿tengo cheques por cobrar?", "ver cheques". cheque_cobrado: un cheque ya se cobró/depositó ("cobré el cheque de X", "entró el cheque").\n`
    + `- nuevo_pago: llega o hay que pagar un SERVICIO o gasto fijo (luz, gas, agua, alquiler, internet, impuestos, proveedor). Ej: "hay que pagar la luz 30 lucas el viernes", "llegó la factura de la luz", "vino la boleta del gas, 45 lucas", "el internet vence el 15". Palabras clave: factura, boleta, vencimiento, servicio.\n`
    + `- ver_pagos: pregunta qué servicios hay que pagar. Ej: "¿qué hay que pagar?", "¿qué facturas vencen?", "¿debo algún servicio?", "ver pagos". pago_hecho: YA lo pagó ("pagué la luz", "ya está el alquiler", "salió el gas").\n`
    + `- nueva_compra: anotar un INSUMO/material para comprar (tinta, vinilo, papel, planchas). Ej: "anotá que falta tinta negra", "se acabó el papel", "hay que comprar vinilo blanco", "traé 2 rollos de lona". Palabras clave: falta, se acabó, comprar, traer.\n`
    + `- ver_compras: pregunta qué falta comprar. Ej: "¿qué hay que comprar?", "¿qué falta?", "lista de compras". compra_hecha: YA lo compró ("compré la tinta", "ya traje los rollos").\n`
    + `- cotizar: pregunta CUÁNTO SALE / CUÁNTO COBRO algo, sin nombrar cliente. Ej: "cuánto salen 100 remeras", "precio de 50 tazas", "cuánto cobro 3 m2 de vinilo", "cotizame 200 volantes".\n`
    + `- ver_precios: pide la lista de precios completa. Ej: "lista de precios", "qué precios tengo cargados", "mostrame los precios".\n`
    + `- ayuda: no sabe qué puede hacer o pide instrucciones. Ej: "qué puedo hacer", "cómo funciona esto", "ayuda".\n`
    + `- nada: el mensaje NO alcanza para actuar: es corto, deíctico o una respuesta suelta sin contexto. Ej: "mostramelo", "mostramelos", "dale", "eso", "y eso?", "cuáles", "ah ok", "jaja", "?".\n`
    + `- ver_activos / ver_bandeja / ver_sin_presupuestar: pide ver esas listas. resumen: "cómo viene/menú/hola".\n`
    + `- confirmar/descartar: "ok/sí" o "no" a un borrador.\n\n`
    + `Distinguí bien: (1) FACTURA/boleta/servicio que se PAGA = pagos; INSUMO/material que se COMPRA en un comercio = compras. (2) El tiempo verbal decide entre anotar y tachar: "hay que pagar / llegó / falta / se acabó" = anotar pendiente (nuevo_pago / nueva_compra); "pagué / ya está / compré / traje" = marcar hecho (pago_hecho / compra_hecha). (3) Un cheque siempre lleva la palabra cheque; si la pregunta menciona CHEQUES ("¿hay cheques por pagar/cobrar?") es ver_cheques, NUNCA consulta: consulta es SOLO para plata de trabajos ("qué me deben", "cuánto facturé").\n`
    + `REGLA IMPORTANTE: nuevo_trabajo SOLO si el mensaje nombra un cliente Y qué hay que hacer. Si falta cualquiera de los dos, o si es una respuesta corta al mensaje anterior ("mostramelo", "dale", "cuáles", "el segundo"), la intención es "nada" con confianza "baja". NUNCA inventes un cliente ni conviertas un pedido de ver algo en un trabajo nuevo. Si preguntan por PRECIO sin nombrar cliente es cotizar, no nuevo_trabajo.\n`
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
    + `- "tipo": "recibido" si SE LO DAN a él / le pagan / lo va a cobrar ("me dieron un cheque", "nos pagaron con e-check", "a cobrar", "entra"). "emitido" si ÉL LO ENTREGA o lo usa para pagar ("le di un cheque", "pagué con e-check", "a pagar", "para pagarle a X", "sale"). Si no está claro, "recibido".\n`
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
function promptCorregirCheque(original, correccion) {
  return `Anotaste un CHEQUE a partir de: "${original}". Le pediste confirmación (ok/no) y el usuario respondió: "${correccion}".\n`
    + `¿Está corrigiendo algún dato del cheque? Devolvé SOLO JSON:\n`
    + `- "corrige": true si corrige algo del cheque; false si habla de OTRA cosa (otro pedido, una consulta, un saludo).\n`
    + `- Campos SOLO con lo corregido (lo que no menciona: null): "tipo" ("recibido" si lo cobra él / se lo dieron / a cobrar; "emitido" si lo paga o entrega él / "a pagar"), "modalidad" (fisico|electronico), "importe" (entero en pesos, lucas=miles), "banco", "relacionado" (cliente o proveedor), "fecha_cobro" (YYYY-MM-DD, hoy es ${hoyISO()}).\n`
    + `OJO: si dice "a pagar" o "es para pagar" está corrigiendo tipo=emitido; NO es un pago de servicio.`;
}
function promptCorregirTrabajo(original, correccion) {
  return `Anotaste un TRABAJO a partir de: "${original}". Le pediste confirmación (ok/no) y el usuario respondió: "${correccion}".\n`
    + `¿Está corrigiendo algún dato del trabajo? Devolvé SOLO JSON:\n`
    + `- "corrige": true si corrige algo del trabajo; false si habla de otra cosa.\n`
    + `- Campos SOLO con lo corregido (lo que no menciona: null): "empresa", "contacto", "descripcion", "disciplina" (laser|serigrafia|ploteo|impresion), "precio" (entero en pesos, lucas=miles).`;
}

router.post('/mensaje', async (req, res) => {
 try {
  const from = (req.body && req.body.from != null) ? String(req.body.from) : '';
  const texto = (req.body && typeof req.body.texto === 'string') ? req.body.texto.trim() : '';
  if (!from) return res.status(400).json({ error: 'Falta from' });
  // SEGURIDAD: el asistente corre sobre la línea del taller, que también recibe mensajes de clientes.
  // Solo responde a los números/IDs de la familia. Lista VACÍA = no responde a NADIE (fail-safe).
  const fromNum = String(from).split('@')[0];
  const autorizado = AUTORIZADOS.length > 0 && (AUTORIZADOS.includes(String(from)) || AUTORIZADOS.includes(fromNum));
  if (!autorizado) { console.log('WA ignorado (no autorizado):', from); return res.json({ reply: null, ignorado: true }); }

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

    // Si el texto describe un ítem NUEVO (cheque o trabajo), lo creamos y le adjuntamos la foto.
    if (texto) {
      const ctxNegocio = await contextoClientes();
      const clasif = await ollamaJSON(promptClasificar(texto, ctxNegocio), SCHEMA.clasificar);
      if (clasif.intencion === 'nuevo_cheque') {
        const c = await ollamaJSON(promptCheque(texto), SCHEMA.cheque);
        const ch = await crearCheque(c);
        await adjuntar('cheque', ch.id, archivo, mime, texto);
        await setCtx(from, 'confirmando', { pendiente: { tipo: 'cheque', id: ch.id, texto } });
        return res.json({ reply: `🧾📎 Anoté un cheque${ch.modalidad === 'electronico' ? ' electrónico (e-check)' : ''} ${ch.tipo === 'recibido' ? 'a cobrar de' : 'a pagar a'} ${ch.relacionado || '—'} ${money(ch.importe)} con la foto adjunta.\nRespondé "ok" para confirmarlo, "no" para descartarlo, o corregime (ej: "es a pagar", "son 250 lucas").` });
      }
      if (clasif.intencion === 'nuevo_trabajo' && pareceTrabajo(texto, clasif)) {
        const tr = await crearBorradorDesde(clasif);
        await adjuntar('trabajo', tr.id, archivo, mime, texto);
        await setCtx(from, 'confirmando', { pendiente: { tipo: 'trabajo', id: tr.id, texto } });
        return res.json({ reply: `🆕📎 Anoté #${tr.id}: ${tr.cliente} — ${tr.descripcion || ''} con la foto adjunta.\nRespondé "ok" para confirmar, "no" para descartar, o corregime (ej: "el precio es 50 lucas").` });
      }
    }

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
  if (esSaludo(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: await menuTexto(from) }); }

  // ---- Esperando la cantidad de una cotización ("¿cuántas unidades?") ----
  if (ctx.estado === 'cotizando') {
    if (/^cancel/i.test(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: '👍 Listo, cancelado.' }); }
    const n = (String(texto).match(/\d+(?:[.,]\d+)?/) || [])[0];
    if (!n) return res.json({ reply: 'Decime solo el número (ej: "100"), o "cancelar".' });
    const { rows } = await query('SELECT * FROM precios WHERE id = $1', [ctx.datos && ctx.datos.cotiza_item]);
    if (!rows[0]) { await setCtx(from, 'idle', {}); return res.json({ reply: 'Se me perdió el ítem 😅 Preguntame de nuevo, ej: "cuánto salen 100 remeras".' }); }
    return res.json({ reply: await cotizarItem(from, rows[0], Number(String(n).replace(',', '.'))) });
  }

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

  // ---- Corrección de un borrador que espera confirmación ("es a pagar", "son 250 lucas") ----
  if (ctx.estado === 'confirmando' && ctx.datos && ctx.datos.pendiente && ctx.datos.pendiente.id && !esSi(t) && !esNo(t)) {
    const pend = ctx.datos.pendiente;
    const memo = (txt) => ((pend.texto || '') + ' | ' + txt).slice(-500);
    if (pend.tipo === 'cheque') {
      const c = await ollamaJSON(promptCorregirCheque(pend.texto || '', texto), SCHEMA.corregirCheque);
      if (c && c.corrige) {
        const ch = await aplicarCorreccionCheque(pend.id, c);
        if (ch) {
          await setCtx(from, 'confirmando', { pendiente: { ...pend, texto: memo(texto) } });
          return res.json({ reply: `🧾 Corregido: cheque${ch.modalidad === 'electronico' ? ' electrónico (e-check)' : ''} ${ch.tipo === 'recibido' ? 'a cobrar de' : 'a pagar a'} ${ch.relacionado || '—'} ${money(ch.importe)}${ch.fecha_cobro ? ` (${fmtFecha(ch.fecha_cobro)})` : ''}.\nRespondé "ok" para confirmarlo, "no" para descartarlo, o corregime de nuevo.` });
        }
      }
    }
    if (pend.tipo === 'trabajo') {
      const c = await ollamaJSON(promptCorregirTrabajo(pend.texto || '', texto), SCHEMA.corregirTrabajo);
      if (c && c.corrige) {
        const tr = await aplicarCorreccionTrabajo(pend.id, c);
        if (tr) {
          await setCtx(from, 'confirmando', { pendiente: { ...pend, texto: memo(texto) } });
          return res.json({ reply: `🆕 Corregido #${tr.id}: ${tr.cliente} — ${tr.descripcion || ''} — ${money(tr.precio)}.\nRespondé "ok" para confirmar, "no" para descartar, o corregime de nuevo.` });
        }
      }
    }
    // No era una corrección: sigue el flujo normal (consulta, otro pedido, etc.)
  }

  // "anotalo para Andreu" justo después de una cotización → trabajo con cantidad y unitario.
  if (ctx.datos && ctx.datos.cotizacion && RE_ANOTAR.test(t)) {
    const r = await anotarCotizacion(from, ctx, texto);
    if (r) return res.json({ reply: r });
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

  // Responde una opción del menú numerado (1 a 7) y recuerda el tema.
  const responderTema = async (tema) => {
    const r = await mostrarTema(from, tema);
    await setUltimo(from, tema);
    return res.json({ reply: r });
  };
  for (const n of Object.keys(OPCIONES)) if (esOpcion(n)) return responderTema(OPCIONES[n]);

  // Atajos directos sin pasar por la IA: responden al instante aunque el modelo
  // esté descargado de la GPU (arranque en frío) y nunca se clasifican mal.
  // Sacamos los prefijos de cortesía para que "dale mostrame los cheques" ≡ "cheques".
  const tt = normTxt(t)
    .replace(/^(dale|ok|oka|che|por favor|porfa|bueno|si|y)\s+/, '')
    .replace(/^(mostrame|mostrar|mostra|pasame|pasar|dame|quiero ver|querria ver|necesito ver|veamos|listame|abrime|abri|ver)\s+/, '')
    .replace(/^(los|las|el|la|mis|un|una)\s+/, '')
    .trim();
  const atajo = (re) => re.test(t) || re.test(tt);
  if (atajo(/^(ver\s+)?(los\s+)?trabajos(\s+(en\s+curso|activos|pendientes))?\s*\??$/i) || tt === 'activos') return responderTema('trabajos');
  if (atajo(/^(ver\s+)?(la\s+)?bandeja\s*\??$/i)) return responderTema('bandeja');
  if (atajo(/^(ver\s+)?(los\s+)?cheques(\s+pendientes)?\s*\??$/i)) return responderTema('cheques');
  if (atajo(/^(ver\s+)?(los\s+)?pagos(\s+pendientes)?\s*\??$/i)) return responderTema('pagos');
  if (atajo(/^(ver\s+)?(la\s+)?lista\s+de\s+precios\s*\??$/i) || tt === 'precios' || atajo(/^precios\s*\??$/i)) return responderTema('precios');
  if (atajo(/^(ver\s+)?(la\s+)?(lista(\s+de\s+compras)?|compras)\s*\??$/i)) return responderTema('compras');
  if (atajo(/^(ver\s+)?sin\s+presupuestar\s*\??$/i)) return responderTema('sin_presupuestar');

  // Respuestas deícticas: "mostrámelos", "cuáles", "dale pasame". Se refieren a lo
  // último que nombramos. Sin esto, terminaban creando un trabajo fantasma con precio 0.
  if (RE_MOSTRAR.test(normTxt(texto))) {
    const tema = ctx.datos && ctx.datos.ultimo;
    if (tema && Object.values(OPCIONES).includes(tema)) return responderTema(tema);
    return res.json({ reply: await noEntendi(from) });
  }

  // Router con contexto
  const ctxNegocio = await contextoClientes();
  const d = await ollamaJSON(promptClasificar(texto, ctxNegocio), SCHEMA.clasificar);
  if (!d || Object.keys(d).length === 0) return res.json({ reply: '🤖 Uy, no te pude procesar (la IA no respondió). ¿Me lo repetís?' });
  // Sin intención clara ya NO asumimos "nuevo_trabajo": ese default era el que
  // convertía cualquier mensaje suelto en un trabajo guardado con precio 0.
  const intent = d.intencion || 'nada';
  const idMenc = d.id || (texto.match(/#?(\d{1,6})/) ? Number(texto.match(/#?(\d{1,6})/)[1]) : null);

  if (intent === 'ver_activos') return responderTema('trabajos');
  if (intent === 'ver_bandeja') return responderTema('bandeja');
  if (intent === 'ver_sin_presupuestar') return responderTema('sin_presupuestar');
  if (intent === 'ver_precios') return responderTema('precios');
  if (intent === 'cotizar') return res.json({ reply: await cotizarTexto(from, d, texto) });
  if (intent === 'resumen') return res.json({ reply: await menuTexto(from) });
  if (intent === 'ayuda') return res.json({ reply: ayudaTexto() });
  if (intent === 'nada') return res.json({ reply: await noEntendi(from) });
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
  if (intent === 'ver_cheques') {
    // Dirección pedida en el propio texto: "por pagar" = emitidos, "por cobrar / entran" = recibidos.
    const filtro = /pagar|emitid|salen|debo pagar/i.test(texto) ? 'emitido'
      : /cobrar|recibid|entra/i.test(texto) ? 'recibido' : null;
    const r = await listarCheques(filtro);
    await setUltimo(from, 'cheques');
    return res.json({ reply: r });
  }
  if (intent === 'nuevo_cheque') {
    const c = await ollamaJSON(promptCheque(texto), SCHEMA.cheque);
    const ch = await crearCheque(c);
    await setCtx(from, 'confirmando', { pendiente: { tipo: 'cheque', id: ch.id, texto } });
    return res.json({ reply: `🧾 Anoté un cheque${ch.modalidad === 'electronico' ? ' electrónico (e-check)' : ''} ${ch.tipo === 'recibido' ? 'a cobrar de' : 'a pagar a'} ${ch.relacionado || '—'} ${money(ch.importe)}${ch.fecha_cobro ? `, ${fmtFecha(ch.fecha_cobro)}` : ''}.\nRespondé "ok" para confirmarlo, "no" para descartarlo, o corregime (ej: "es a pagar", "son 250 lucas").` });
  }
  if (intent === 'cheque_cobrado') {
    const r = await ollamaJSON(promptNombre(texto, 'cobró un cheque'), SCHEMA.refNombre);
    const ch = await marcarChequeCobrado(r.nombre);
    return res.json({ reply: ch ? `✅ Cheque de ${ch.relacionado || '—'} ${money(ch.importe)} marcado como cobrado.` : 'No encontré ese cheque pendiente. Escribí "ver cheques".' });
  }

  // ----- Pagos de servicios -----
  if (intent === 'ver_pagos') return responderTema('pagos');
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
  if (intent === 'ver_compras') return responderTema('compras');
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

  // nuevo_trabajo, PERO solo si de verdad parece un pedido (cliente + qué hacer).
  // Sin esta guardia, todo lo que no encajaba en otra intención se guardaba como
  // trabajo con precio 0: era la causa de que el bot pareciera tonto.
  if (intent === 'nuevo_trabajo' && pareceTrabajo(texto, d)) {
    const tr = await crearBorradorDesde(d);
    await setCtx(from, 'confirmando', { pendiente: { tipo: 'trabajo', id: tr.id, texto }, ultimo: 'bandeja' });
    return res.json({ reply: `🆕 Anoté #${tr.id}: ${tr.cliente} — ${tr.descripcion || ''} — ${money(tr.precio)}. Respondé "ok" para confirmar, "no" para descartar, o corregime (ej: "el precio es 50 lucas").` });
  }
  // No entendimos: preguntamos en vez de inventar.
  return res.json({ reply: await noEntendi(from) });
 } catch (e) {
   console.error('mensaje error:', e.message);
   if (!res.headersSent) res.json({ reply: '🤖 Uf, tuve un problema con eso. Probá de nuevo en un ratito.' });
 }
});

// Recordatorio de las 9 y las 22. Devuelve reply:null cuando NO hay nada pendiente
// (n8n corta ahí y no manda mensaje: nada de ruido cuando está todo al día).
router.get('/nudge', async (req, res) => {
  const to = (req.query.to || '').trim();
  const reply = await nudgeTexto();
  if (reply && to) await setCtx(to, 'idle', {});
  res.json({ reply, hay: !!reply });
});

export default router;

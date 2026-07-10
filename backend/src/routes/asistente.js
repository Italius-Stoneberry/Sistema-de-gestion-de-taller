import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereIngest } from '../auth.js';
import { resolverEmpresa, resolverContacto } from '../resolvers.js';

const router = Router();
router.use(requiereIngest);

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b';
const DISCIPLINAS = ['laser', 'serigrafia', 'ploteo'];
const AUTORIZADOS = (process.env.AUTORIZADOS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function ollamaJSON(prompt) {
  try {
    const r = await fetch(OLLAMA_URL + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, format: 'json', options: { temperature: 0 } }),
    });
    const j = await r.json();
    return JSON.parse(j.response || '{}');
  } catch (e) { console.error('ollama:', e.message); return {}; }
}

async function getCtx(chatId) {
  const { rows } = await query('SELECT estado, datos FROM conversaciones WHERE chat_id = $1', [chatId]);
  return rows[0] || { estado: 'idle', datos: {} };
}
async function setCtx(chatId, estado, datos) {
  await query(
    `INSERT INTO conversaciones (chat_id, estado, datos, actualizado_en) VALUES ($1,$2,$3,now())
     ON CONFLICT (chat_id) DO UPDATE SET estado = $2, datos = $3, actualizado_en = now()`,
    [chatId, estado, JSON.stringify(datos || {})]
  );
}

// Contexto del negocio: clientes/empresas conocidos, para que la IA desambigüe persona vs empresa
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
  return `🤖 ¡Buenas! Tenés:\n• ${c.activos} trabajos en curso\n• ${c.bandeja} en la bandeja sin confirmar\n• ${c.sin_presup} sin presupuestar\n\nPreguntame lo que quieras ("qué tengo pendiente", "mostrame la bandeja") o mandame un pedido nuevo.`;
}
async function listarActivos(chatId) {
  const { rows } = await query(`SELECT id, cliente, descripcion, estado FROM trabajos WHERE estado IN ('pedido','en_progreso','en_espera') AND revisado ORDER BY actualizado_en ASC LIMIT 8`);
  if (!rows.length) { if (chatId) await setCtx(chatId, 'idle', {}); return 'No hay trabajos en curso 👍'; }
  const lista = rows.map((r, i) => ({ n: i + 1, id: r.id, cliente: r.cliente, descripcion: r.descripcion, estado: r.estado }));
  if (chatId) await setCtx(chatId, 'eligiendo', { lista });
  const txt = lista.map((x) => `${x.n}) #${x.id} ${x.cliente} — ${x.descripcion || ''} [${x.estado}]`).join('\n');
  return `Trabajos en curso:\n${txt}\n\nContame qué pasó, ej: "el 1 se terminó y se cobró".`;
}
async function listarBandeja() {
  const { rows } = await query('SELECT id, cliente, descripcion, precio FROM trabajos WHERE revisado = FALSE ORDER BY creado_en DESC LIMIT 10');
  if (!rows.length) return 'La bandeja está vacía 👍';
  const txt = rows.map((r) => `#${r.id} ${r.cliente} — ${r.descripcion || ''} ($${r.precio})`).join('\n');
  return `Bandeja (sin confirmar):\n${txt}\n\nRespondé "ok #<n>" para confirmar o "no #<n>" para descartar.`;
}
async function listarSinPresup() {
  const { rows } = await query("SELECT id, cliente, descripcion FROM trabajos WHERE estado = 'cotizar' AND revisado ORDER BY creado_en ASC LIMIT 10");
  if (!rows.length) return 'No hay nada sin presupuestar 👍';
  return 'Sin presupuestar:\n' + rows.map((r) => `#${r.id} ${r.cliente} — ${r.descripcion || ''}`).join('\n');
}
async function aplicar(id, campos) {
  const sets = []; const vals = [];
  if (campos.finalizado === true) { vals.push('finalizado'); sets.push(`estado = $${vals.length}`); }
  else if (campos.estado) { vals.push(campos.estado); sets.push(`estado = $${vals.length}`); }
  if (campos.pagado === true || campos.pagado === false) { vals.push(campos.pagado); sets.push(`pagado = $${vals.length}`); }
  if (campos.facturado === true || campos.facturado === false) { vals.push(campos.facturado); sets.push(`facturado = $${vals.length}`); }
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await query(`UPDATE trabajos SET ${sets.join(', ')}, actualizado_en = now() WHERE id = $${vals.length} RETURNING *`, vals);
  await audit(null, 'asistente', 'trabajo', id, campos);
  return rows[0];
}
async function crearBorradorDesde(d) {
  const empresaId = (d.empresa && d.empresa.trim()) ? await resolverEmpresa(d.empresa.trim(), 'ia') : null;
  const contactoId = (d.contacto && d.contacto.trim()) ? await resolverContacto(d.contacto.trim(), empresaId, 'ia') : null;
  const cliente = (d.contacto && d.contacto.trim())
    ? (d.contacto.trim() + (d.empresa && d.empresa.trim() ? ` (${d.empresa.trim()})` : ''))
    : ((d.empresa && d.empresa.trim()) || 'Sin nombre');
  const disciplina = DISCIPLINAS.includes(d.disciplina) ? d.disciplina : 'laser';
  const { rows } = await query(
    `INSERT INTO trabajos (cliente, empresa_id, contacto_id, descripcion, disciplina, estado, precio, origen, revisado, origen_ref)
     VALUES ($1,$2,$3,$4,$5,'pedido',$6,'ia',FALSE,$7) RETURNING *`,
    [cliente, empresaId, contactoId, d.descripcion || null, disciplina, Number(d.precio) || 0, 'WhatsApp']
  );
  await audit(null, 'ingesta', 'trabajo', rows[0].id, null);
  return rows[0];
}
async function confirmarBorrador(accion, id) {
  if (!id) {
    const r = await query("SELECT id FROM trabajos WHERE revisado = FALSE AND origen = 'ia' ORDER BY creado_en DESC LIMIT 1");
    if (!r.rows[0]) return null;
    id = r.rows[0].id;
  }
  if (accion === 'descartar') {
    const { rows } = await query('DELETE FROM trabajos WHERE id = $1 AND revisado = FALSE RETURNING cliente', [id]);
    return rows[0] ? { accion: 'descartado', id, cliente: rows[0].cliente } : null;
  }
  const { rows } = await query('UPDATE trabajos SET revisado = TRUE, actualizado_en = now() WHERE id = $1 RETURNING cliente', [id]);
  return rows[0] ? { accion: 'confirmado', id, cliente: rows[0].cliente } : null;
}

const esSi = (t) => /^(s[ií]|dale|obvio|sip|yes|ya|listo)\b/i.test(t);
const esNo = (t) => /^(no|nop|todav[ií]a|a[uú]n no|negativo)\b/i.test(t);
const esSaludo = (t) => ['hola', 'menu', 'menú', 'inicio', 'buenas', 'empezar', 'buen dia'].includes(t);
const esSalir = (t) => ['salir', 'chau', 'gracias', 'nada', 'listo gracias', 'no gracias'].includes(t);

function promptClasificar(texto, ctxNegocio) {
  return `Sos el asistente de un taller gráfico. Interpretás mensajes de WhatsApp escritos informalmente (jerga argentina, sin puntuación).\n\n`
    + `${ctxNegocio}\n\n`
    + `El usuario escribió: "${texto}".\n\n`
    + `Devolvé SOLO un JSON con:\n`
    + `- "intencion": una de [nuevo_trabajo, ver_activos, ver_bandeja, ver_sin_presupuestar, resumen, confirmar, descartar].\n`
    + `- "id": número de trabajo si menciona uno (ej #5), si no null.\n`
    + `- si es nuevo_trabajo: "empresa", "contacto", "descripcion", "disciplina" (laser|serigrafia|ploteo), "precio" (entero en pesos, 0 si no se menciona).\n\n`
    + `REGLAS DE CLIENTE (muy importante, usá las listas de arriba):\n`
    + `- Si el nombre coincide o se parece a una EMPRESA conocida => es empresa.\n`
    + `- Si coincide a un CONTACTO conocido => es contacto (persona); si ese contacto tiene empresa, poné esa empresa.\n`
    + `- Formato "X de Y" => contacto: X, empresa: Y.\n`
    + `- Un nombre de persona suelto y desconocido (sin empresa) => contacto (cliente individual), empresa: "".\n`
    + `- NUNCA inventes ni pongas etiquetas como "cliente individual" o "particular" como nombre. Si no hay empresa, dejá empresa: "".\n\n`
    + `INTENCIÓN según contenido:\n`
    + `- Describe un encargo (cliente/cantidad/producto/precio) => nuevo_trabajo.\n`
    + `- "qué tengo / en curso / pendientes / en proceso" => ver_activos.\n`
    + `- "bandeja / sin confirmar / qué entró / borradores" => ver_bandeja.\n`
    + `- "sin presupuestar / falta cotizar / presupuestos" => ver_sin_presupuestar.\n`
    + `- "resumen / cómo viene / menú / hola" => resumen.\n`
    + `- "ok / sí / dale / listo / confirmá" => confirmar. "no / descartá" => descartar.\n`
    + `Jerga de plata: luca/lucas = miles (80 lucas = 80000); palo = millón; gamba = 100.`;
}

router.post('/mensaje', async (req, res) => {
  const from = (req.body && req.body.from) || '';
  const texto = ((req.body && req.body.texto) || '').trim();
  if (!from) return res.status(400).json({ error: 'Falta from' });
  if (AUTORIZADOS.length && !AUTORIZADOS.includes(from)) return res.json({ reply: null, ignorado: true });

  const t = texto.toLowerCase();
  const ctx = await getCtx(from);
  const esOpcion = (n) => t === String(n) || t === n + ')' || t === n + '.';

  if (esSalir(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: '👍 Cuando quieras.' }); }
  if (esSaludo(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: await menuTexto() }); }

  // Diálogo de actualización en curso (prioridad)
  if (ctx.estado === 'eligiendo') {
    const lista = (ctx.datos && ctx.datos.lista) || [];
    const listaTxt = lista.map((x) => `${x.n}) #${x.id} ${x.cliente} ${x.descripcion || ''}`).join('; ');
    const d = await ollamaJSON(`Trabajos: ${listaTxt}.\nEl usuario dijo: "${texto}".\nDevolvé SOLO JSON: n (número de la lista o null), finalizado (true/null), pagado (true/false/null), facturado (true/false/null).`);
    const item = lista.find((x) => x.n == d.n);
    if (!item) return res.json({ reply: 'No entendí a cuál. Decime el número, ej: "el 1 se terminó". (o "menu")' });
    await aplicar(item.id, { finalizado: d.finalizado === true, pagado: d.pagado, facturado: d.facturado });
    if (d.finalizado === true && d.pagado !== true && d.pagado !== false) {
      await setCtx(from, 'preg_cobro', { trabajo_id: item.id, n: item.n, facturado: d.facturado });
      return res.json({ reply: `Anotado ✍️ ¿El ${item.n} (#${item.id}) quedó cobrado? (sí/no)` });
    }
    if (d.finalizado === true && d.facturado !== true && d.facturado !== false) {
      await setCtx(from, 'preg_factura', { trabajo_id: item.id });
      return res.json({ reply: '¿Y quedó facturado? (sí/no)' });
    }
    await setCtx(from, 'idle', {});
    return res.json({ reply: `✅ Listo #${item.id}.` });
  }
  if (ctx.estado === 'preg_cobro') {
    const v = esSi(t) ? true : esNo(t) ? false : null;
    if (v === null) return res.json({ reply: 'Respondé sí o no 🙂 ¿Quedó cobrado?' });
    await aplicar(ctx.datos.trabajo_id, { pagado: v });
    if (ctx.datos.facturado !== true && ctx.datos.facturado !== false) {
      await setCtx(from, 'preg_factura', { trabajo_id: ctx.datos.trabajo_id });
      return res.json({ reply: '¿Y quedó facturado? (sí/no)' });
    }
    await setCtx(from, 'idle', {});
    return res.json({ reply: `✅ Listo #${ctx.datos.trabajo_id}.` });
  }
  if (ctx.estado === 'preg_factura') {
    const v = esSi(t) ? true : esNo(t) ? false : null;
    if (v === null) return res.json({ reply: 'Respondé sí o no. ¿Quedó facturado?' });
    await aplicar(ctx.datos.trabajo_id, { facturado: v });
    await setCtx(from, 'idle', {});
    return res.json({ reply: `✅ Listo #${ctx.datos.trabajo_id}, actualizado.` });
  }

  if (esOpcion(1)) return res.json({ reply: await listarActivos(from) });
  if (esOpcion(2)) return res.json({ reply: await listarBandeja() });
  if (esOpcion(3)) return res.json({ reply: await listarSinPresup() });

  // Router + Normalizador con contexto del negocio
  const ctxNegocio = await contextoClientes();
  const d = await ollamaJSON(promptClasificar(texto, ctxNegocio));
  const intent = d.intencion || 'nuevo_trabajo';
  const idMenc = d.id || (texto.match(/#?(\d{1,6})/) ? Number(texto.match(/#?(\d{1,6})/)[1]) : null);

  if (intent === 'ver_activos') return res.json({ reply: await listarActivos(from) });
  if (intent === 'ver_bandeja') return res.json({ reply: await listarBandeja() });
  if (intent === 'ver_sin_presupuestar') return res.json({ reply: await listarSinPresup() });
  if (intent === 'resumen') return res.json({ reply: await menuTexto() });
  if (intent === 'confirmar' || intent === 'descartar') {
    const r = await confirmarBorrador(intent, idMenc);
    if (!r) return res.json({ reply: 'No hay borradores pendientes. Mandame un pedido o preguntame qué tenés.' });
    return res.json({ reply: r.accion === 'descartado' ? `🗑 Descartado #${r.id}` : `✅ Confirmado #${r.id} (${r.cliente})` });
  }
  const tr = await crearBorradorDesde(d);
  return res.json({ reply: `🆕 Anoté #${tr.id}: ${tr.cliente} — ${tr.descripcion || ''} — $${tr.precio}. Respondé "ok" para confirmar o "no" para descartar.` });
});

router.get('/nudge', async (req, res) => {
  const to = (req.query.to || '').trim();
  if (to) await setCtx(to, 'idle', {});
  res.json({ reply: await menuTexto() });
});

export default router;

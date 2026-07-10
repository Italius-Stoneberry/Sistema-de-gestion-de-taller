import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereIngest } from '../auth.js';
import { resolverEmpresa, resolverContacto } from '../resolvers.js';

const router = Router();
router.use(requiereIngest); // lo llama n8n con la API key

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const DISCIPLINAS = ['laser', 'serigrafia', 'ploteo'];
// Números autorizados (coma-separados en la env AUTORIZADOS). Vacío = permitir a todos.
const AUTORIZADOS = (process.env.AUTORIZADOS || '').split(',').map((s) => s.trim()).filter(Boolean);

const REGLAS = [
  'Extraé datos de un mensaje de un taller gráfico y devolvé SOLO un JSON válido, sin explicaciones.',
  'Claves: empresa, contacto, descripcion, disciplina (uno de: laser, serigrafia, ploteo), precio (entero en pesos, 0 si no se menciona).',
  "Regla 'X de Y': X es el contacto (persona), Y es la empresa. Ej: 'marianela de andreu' => contacto 'Marianela', empresa 'Andreu'.",
  'Jerga argentina de plata: luca/lucas = miles (80 lucas = 80000); palo = millon; gamba = 100.',
].join('\n');

async function ollamaJSON(prompt) {
  try {
    const r = await fetch(OLLAMA_URL + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, format: 'json' }),
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
  return `🤖 ¡Buenas! Tenés:\n• ${c.activos} trabajos en curso\n• ${c.bandeja} en la bandeja sin confirmar\n• ${c.sin_presup} sin presupuestar\n\nRespondé:\n1) actualizar trabajos\n2) revisar bandeja\n3) sin presupuestar`;
}

async function listarActivos(chatId) {
  const { rows } = await query(
    `SELECT id, cliente, descripcion, estado FROM trabajos
     WHERE estado IN ('pedido','en_progreso','en_espera') AND revisado
     ORDER BY actualizado_en ASC LIMIT 8`);
  if (!rows.length) { await setCtx(chatId, 'idle', {}); return 'No hay trabajos en curso 👍 (mandame un pedido, o "menu")'; }
  const lista = rows.map((r, i) => ({ n: i + 1, id: r.id, cliente: r.cliente, descripcion: r.descripcion, estado: r.estado }));
  await setCtx(chatId, 'eligiendo', { lista });
  const txt = lista.map((x) => `${x.n}) #${x.id} ${x.cliente} — ${x.descripcion || ''} [${x.estado}]`).join('\n');
  return `Trabajos en curso:\n${txt}\n\nContame qué pasó, ej: "el 1 se terminó y se cobró". (o "menu")`;
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

// Crea un borrador (revisado=false) a partir del texto de un pedido nuevo
async function crearBorrador(texto) {
  const d = await ollamaJSON(REGLAS + '\nMensaje: ' + texto);
  const empresaId = d.empresa ? await resolverEmpresa(d.empresa, 'ia') : null;
  const contactoId = d.contacto ? await resolverContacto(d.contacto, empresaId, 'ia') : null;
  const cliente = d.contacto ? (d.contacto + (d.empresa ? ` (${d.empresa})` : '')) : (d.empresa || 'Sin nombre');
  const disciplina = DISCIPLINAS.includes(d.disciplina) ? d.disciplina : 'laser';
  const { rows } = await query(
    `INSERT INTO trabajos (cliente, empresa_id, contacto_id, descripcion, disciplina, estado, precio, origen, revisado, origen_ref)
     VALUES ($1,$2,$3,$4,$5,'pedido',$6,'ia',FALSE,$7) RETURNING *`,
    [cliente, empresaId, contactoId, d.descripcion || null, disciplina, Number(d.precio) || 0, 'WhatsApp']
  );
  await audit(null, 'ingesta', 'trabajo', rows[0].id, null);
  return rows[0];
}

// Confirma o descarta el borrador más reciente (o por id)
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
const esSaludo = (t) => ['hola', 'menu', 'menú', 'inicio', 'buenas', 'empezar', 'buen dia', 'buenas'].includes(t);
const esSalir = (t) => ['salir', 'chau', 'gracias', 'nada', 'listo gracias', 'no gracias'].includes(t);

// POST /api/asistente/mensaje  { from, texto } -> { reply }
router.post('/mensaje', async (req, res) => {
  const from = (req.body && req.body.from) || '';
  const texto = ((req.body && req.body.texto) || '').trim();
  if (!from) return res.status(400).json({ error: 'Falta from' });
  if (AUTORIZADOS.length && !AUTORIZADOS.includes(from)) return res.json({ reply: null, ignorado: true });

  const t = texto.toLowerCase();
  const ctx = await getCtx(from);
  const esOpcion = (n) => t === String(n) || t === n + ')' || t === n + '.';

  // Salir del asistente
  if (esSalir(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: '👍 Dale, cuando quieras mandame un pedido o escribí "menu".' }); }

  // Menú (siempre disponible)
  if (esSaludo(t)) { await setCtx(from, 'idle', {}); return res.json({ reply: await menuTexto() }); }

  // --- Diálogo en curso (estos estados mandan) ---
  if (ctx.estado === 'eligiendo') {
    const lista = (ctx.datos && ctx.datos.lista) || [];
    const listaTxt = lista.map((x) => `${x.n}) #${x.id} ${x.cliente} ${x.descripcion || ''}`).join('; ');
    const prompt = `Trabajos disponibles: ${listaTxt}.\nEl usuario dijo: "${texto}".\n`
      + 'Devolvé SOLO un JSON con: n (número de la lista, o null), '
      + 'finalizado (true si dice que se terminó/completó/entregó, si no null), '
      + 'pagado (true si se cobró/pagó, false si dice que no, si no null), '
      + 'facturado (true si se facturó, false si dice que no, si no null).';
    const d = await ollamaJSON(prompt);
    const item = lista.find((x) => x.n == d.n);
    if (!item) return res.json({ reply: 'No entendí a cuál. Decime el número, ej: "el 1 se terminó". (o "menu")' });
    await aplicar(item.id, { finalizado: d.finalizado === true, pagado: d.pagado, facturado: d.facturado });
    if (d.finalizado === true && d.pagado !== true && d.pagado !== false) {
      await setCtx(from, 'preg_cobro', { trabajo_id: item.id, n: item.n, facturado: d.facturado });
      return res.json({ reply: `Anotado ✍️ ¿El ${item.n} (#${item.id}) quedó cobrado? (sí/no)` });
    }
    if (d.finalizado === true && d.facturado !== true && d.facturado !== false) {
      await setCtx(from, 'preg_factura', { trabajo_id: item.id, n: item.n });
      return res.json({ reply: '¿Y quedó facturado? (sí/no)' });
    }
    await setCtx(from, 'idle', {});
    return res.json({ reply: `✅ Listo #${item.id}. Escribí "1" para seguir, o "menu".` });
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
    return res.json({ reply: `✅ Listo #${ctx.datos.trabajo_id}. Escribí "1" para seguir o "menu".` });
  }

  if (ctx.estado === 'preg_factura') {
    const v = esSi(t) ? true : esNo(t) ? false : null;
    if (v === null) return res.json({ reply: 'Respondé sí o no. ¿Quedó facturado?' });
    await aplicar(ctx.datos.trabajo_id, { facturado: v });
    await setCtx(from, 'idle', {});
    return res.json({ reply: `✅ Listo #${ctx.datos.trabajo_id}, actualizado. Escribí "1" para seguir o "menu".` });
  }

  // --- Sin diálogo activo (idle): opciones de menú, confirmación, o pedido nuevo ---
  if (esOpcion(1)) return res.json({ reply: await listarActivos(from) });
  if (esOpcion(2)) {
    const c = await contar();
    return res.json({ reply: `Tenés ${c.bandeja} borrador(es) en la bandeja. Confirmalos con "ok"/"no" o en la web. (o "menu")` });
  }
  if (esOpcion(3)) {
    const { rows } = await query("SELECT id, cliente, descripcion FROM trabajos WHERE estado = 'cotizar' AND revisado ORDER BY creado_en ASC LIMIT 8");
    const txt = rows.length ? rows.map((r) => `#${r.id} ${r.cliente} — ${r.descripcion || ''}`).join('\n') : 'Ninguno 👍';
    return res.json({ reply: `Sin presupuestar:\n${txt}\n\n(escribí "menu")` });
  }

  // Confirmación de un borrador: "ok [id]" / "no [id]"
  const cmd = t.match(/^(ok|s[ií]|dale|listo|no)\b\s*#?(\d+)?/i);
  if (cmd) {
    const accion = /^no/i.test(cmd[1]) ? 'descartar' : 'confirmar';
    const r = await confirmarBorrador(accion, cmd[2] ? Number(cmd[2]) : null);
    if (!r) return res.json({ reply: 'No hay borradores pendientes. Mandame un pedido o escribí "menu".' });
    return res.json({ reply: r.accion === 'descartado' ? `🗑 Descartado #${r.id}` : `✅ Confirmado #${r.id} (${r.cliente})` });
  }

  // Cualquier otra cosa = pedido nuevo
  const tr = await crearBorrador(texto);
  return res.json({ reply: `🆕 Anoté #${tr.id}: ${tr.cliente} — ${tr.descripcion || ''} — $${tr.precio}. Respondé "ok" para confirmar o "no" para descartar. (o "menu")` });
});

// GET /api/asistente/nudge?to=NUMERO  -> deja la conversación en "menú" y devuelve el texto (para el cron)
router.get('/nudge', async (req, res) => {
  const to = (req.query.to || '').trim();
  if (to) await setCtx(to, 'idle', {});
  res.json({ reply: await menuTexto() });
});

export default router;

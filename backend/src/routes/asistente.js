import { Router } from 'express';
import { query, audit } from '../db.js';
import { requiereIngest } from '../auth.js';

const router = Router();
router.use(requiereIngest); // lo llama n8n con la API key

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';

// Llama a Ollama y devuelve el JSON parseado (o {} si falla)
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
  if (!rows.length) { await setCtx(chatId, 'menu', {}); return 'No hay trabajos en curso 👍 (escribí "menu")'; }
  const lista = rows.map((r, i) => ({ n: i + 1, id: r.id, cliente: r.cliente, descripcion: r.descripcion, estado: r.estado }));
  await setCtx(chatId, 'eligiendo', { lista });
  const txt = lista.map((x) => `${x.n}) #${x.id} ${x.cliente} — ${x.descripcion || ''} [${x.estado}]`).join('\n');
  return `Trabajos en curso:\n${txt}\n\nContame qué pasó, ej: "el 1 se terminó y se cobró". (o "menu")`;
}

// Aplica cambios (finalizado / pagado / facturado / estado) a un trabajo
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

const esSi = (t) => /^(s[ií]|dale|obvio|sip|yes|ya|listo)\b/i.test(t);
const esNo = (t) => /^(no|nop|todav[ií]a|a[uú]n no|negativo)\b/i.test(t);

// POST /api/asistente/mensaje  { from, texto }  -> { reply }
router.post('/mensaje', async (req, res) => {
  const from = (req.body && req.body.from) || '';
  const texto = ((req.body && req.body.texto) || '').trim();
  if (!from) return res.status(400).json({ error: 'Falta from' });
  const t = texto.toLowerCase();
  const ctx = await getCtx(from);

  // Comandos globales
  if (['hola', 'menu', 'menú', 'inicio', 'empezar', 'buenas', '0'].includes(t)) {
    await setCtx(from, 'menu', {});
    return res.json({ reply: await menuTexto() });
  }

  if (ctx.estado === 'idle') {
    await setCtx(from, 'menu', {});
    return res.json({ reply: await menuTexto() });
  }

  if (ctx.estado === 'menu') {
    if (t.startsWith('1')) return res.json({ reply: await listarActivos(from) });
    if (t.startsWith('2')) {
      const c = await contar();
      await setCtx(from, 'menu', {});
      return res.json({ reply: `Tenés ${c.bandeja} borrador(es) en la bandeja. Te llegan para confirmar con "ok"/"no" a medida que entran, o revisalos en la web. (o "menu")` });
    }
    if (t.startsWith('3')) {
      const { rows } = await query("SELECT id, cliente, descripcion FROM trabajos WHERE estado = 'cotizar' AND revisado ORDER BY creado_en ASC LIMIT 8");
      await setCtx(from, 'menu', {});
      const txt = rows.length ? rows.map((r) => `#${r.id} ${r.cliente} — ${r.descripcion || ''}`).join('\n') : 'Ninguno 👍';
      return res.json({ reply: `Sin presupuestar:\n${txt}\n\n(escribí "menu")` });
    }
    await setCtx(from, 'menu', {});
    return res.json({ reply: 'No te entendí 🤔\n' + (await menuTexto()) });
  }

  if (ctx.estado === 'eligiendo') {
    const lista = (ctx.datos && ctx.datos.lista) || [];
    const listaTxt = lista.map((x) => `${x.n}) #${x.id} ${x.cliente} ${x.descripcion || ''}`).join('; ');
    const prompt = `Trabajos disponibles: ${listaTxt}.\nEl usuario dijo: "${texto}".\n`
      + `Devolvé SOLO un JSON con: n (número de la lista al que se refiere, o null), `
      + `finalizado (true si dice que se terminó/completó/entregó, si no null), `
      + `pagado (true si se cobró/pagó, false si dice que no, si no se menciona null), `
      + `facturado (true si se facturó/hizo factura, false si dice que no, si no null).`;
    const d = await ollamaJSON(prompt);
    const item = lista.find((x) => x.n == d.n);
    if (!item) return res.json({ reply: 'No entendí a cuál te referís. Decime el número, ej: "el 1 se terminó". (o "menu")' });

    await aplicar(item.id, { finalizado: d.finalizado === true, pagado: d.pagado, facturado: d.facturado });

    if (d.finalizado === true && d.pagado !== true && d.pagado !== false) {
      await setCtx(from, 'preg_cobro', { trabajo_id: item.id, n: item.n, facturado: d.facturado });
      return res.json({ reply: `Anotado ✍️ ¿El ${item.n} (#${item.id}) quedó cobrado? (sí/no)` });
    }
    if (d.finalizado === true && d.facturado !== true && d.facturado !== false) {
      await setCtx(from, 'preg_factura', { trabajo_id: item.id, n: item.n });
      return res.json({ reply: '¿Y quedó facturado? (sí/no)' });
    }
    await setCtx(from, 'menu', {});
    return res.json({ reply: `✅ Listo #${item.id}. ¿Otro? Escribí "1" para seguir, o "menu".` });
  }

  const siNo = esSi(t) ? true : esNo(t) ? false : null;

  if (ctx.estado === 'preg_cobro') {
    if (siNo === null) return res.json({ reply: 'Respondé sí o no 🙂 ¿Quedó cobrado?' });
    await aplicar(ctx.datos.trabajo_id, { pagado: siNo });
    if (ctx.datos.facturado !== true && ctx.datos.facturado !== false) {
      await setCtx(from, 'preg_factura', { trabajo_id: ctx.datos.trabajo_id, n: ctx.datos.n });
      return res.json({ reply: '¿Y quedó facturado? (sí/no)' });
    }
    await setCtx(from, 'menu', {});
    return res.json({ reply: `✅ Listo #${ctx.datos.trabajo_id}. ¿Otro? Escribí "1" o "menu".` });
  }

  if (ctx.estado === 'preg_factura') {
    if (siNo === null) return res.json({ reply: 'Respondé sí o no. ¿Quedó facturado?' });
    await aplicar(ctx.datos.trabajo_id, { facturado: siNo });
    await setCtx(from, 'menu', {});
    return res.json({ reply: `✅ Listo #${ctx.datos.trabajo_id}, actualizado. ¿Otro? Escribí "1" o "menu".` });
  }

  await setCtx(from, 'menu', {});
  return res.json({ reply: await menuTexto() });
});

// GET /api/asistente/resumen  -> el texto del "pinchazo" (para el cron de n8n)
router.get('/resumen', async (req, res) => {
  res.json({ reply: await menuTexto() });
});

export default router;

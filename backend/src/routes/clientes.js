import { Router } from 'express';
import { query, pool } from '../db.js';
import { requiereAuthOIngest, soloAdmin } from '../auth.js';
import { normalizarNombre, claveNombre } from '../resolvers.js';

const router = Router();
router.use(requiereAuthOIngest); // app (JWT) o n8n (API key)

// GET /api/clientes/buscar?q=texto -> mejores coincidencias de contactos y empresas
router.get('/buscar', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ empresas: [], contactos: [] });
  const empresas = await query(
    `SELECT id, nombre, condicion_pago, similarity(nombre,$1) AS score
     FROM empresas WHERE nombre ILIKE '%'||$1||'%' OR nombre % $1
     ORDER BY score DESC, nombre LIMIT 8`, [q]
  );
  const contactos = await query(
    `SELECT c.id, c.nombre, c.empresa_id, e.nombre AS empresa_nombre, similarity(c.nombre,$1) AS score
     FROM contactos c LEFT JOIN empresas e ON e.id = c.empresa_id
     WHERE c.nombre ILIKE '%'||$1||'%' OR c.nombre % $1
     ORDER BY score DESC, c.nombre LIMIT 8`, [q]
  );
  res.json({ empresas: empresas.rows, contactos: contactos.rows });
});

// GET /api/clientes/vocabulario -> lista plana de nombres (para transcripción/LLM)
router.get('/vocabulario', async (req, res) => {
  const emp = await query('SELECT nombre FROM empresas ORDER BY nombre');
  const con = await query('SELECT nombre FROM contactos ORDER BY nombre');
  const nombres = [...emp.rows.map((r) => r.nombre), ...con.rows.map((r) => r.nombre)];
  res.json({ nombres });
});

// POST /api/clientes/unificar  (solo admin) -> une duplicados y normaliza nombres.
// Regla: mismo nombre (comparación normalizada) = misma entidad, SALVO contactos
// con empresas distintas, que se respetan como personas diferentes.
router.post('/unificar', soloAdmin, async (req, res) => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    let empresasUnificadas = 0;
    let contactosUnificados = 0;

    // ---- EMPRESAS: agrupar por clave de nombre ----
    const emp = (await cli.query('SELECT id, nombre, telefono, notas FROM empresas ORDER BY id')).rows;
    const gruposE = new Map();
    for (const e of emp) {
      const k = claveNombre(e.nombre);
      if (!gruposE.has(k)) gruposE.set(k, []);
      gruposE.get(k).push(e);
    }
    for (const g of gruposE.values()) {
      const surv = g.find((e) => e.telefono || e.notas) || g[0];
      for (const dup of g) {
        if (dup.id === surv.id) continue;
        await cli.query('UPDATE contactos SET empresa_id = $1 WHERE empresa_id = $2', [surv.id, dup.id]);
        await cli.query('UPDATE trabajos  SET empresa_id = $1 WHERE empresa_id = $2', [surv.id, dup.id]);
        await cli.query('DELETE FROM empresas WHERE id = $1', [dup.id]);
        empresasUnificadas++;
      }
    }

    // ---- CONTACTOS: mismo nombre -> unificar por empresa ----
    const con = (await cli.query('SELECT id, nombre, empresa_id, telefono, notas FROM contactos ORDER BY id')).rows;
    const gruposC = new Map();
    for (const c of con) {
      const k = claveNombre(c.nombre);
      if (!gruposC.has(k)) gruposC.set(k, []);
      gruposC.get(k).push(c);
    }
    for (const g of gruposC.values()) {
      // Empresas distintas presentes en el grupo (sin contar los "sin empresa")
      const empresasDelGrupo = [...new Set(g.filter((c) => c.empresa_id != null).map((c) => c.empresa_id))];
      // Destino de cada contacto: su empresa; los sin-empresa se suman a la única
      // empresa del grupo si hay exactamente una (si hay varias, se dejan como están).
      const destino = (c) => c.empresa_id ?? (empresasDelGrupo.length === 1 ? empresasDelGrupo[0] : null);
      const porDestino = new Map();
      for (const c of g) {
        const k2 = String(destino(c));
        if (empresasDelGrupo.length > 1 && c.empresa_id == null) continue; // ambiguo: no tocar
        if (!porDestino.has(k2)) porDestino.set(k2, []);
        porDestino.get(k2).push(c);
      }
      for (const [k2, sub] of porDestino) {
        const empresaFinal = k2 === 'null' ? null : Number(k2);
        const surv = sub.find((c) => c.empresa_id === empresaFinal && (c.telefono || c.notas))
          || sub.find((c) => c.empresa_id === empresaFinal) || sub[0];
        for (const dup of sub) {
          if (dup.id === surv.id) continue;
          await cli.query('UPDATE trabajos SET contacto_id = $1 WHERE contacto_id = $2', [surv.id, dup.id]);
          if (!surv.telefono && dup.telefono) await cli.query('UPDATE contactos SET telefono = $1 WHERE id = $2', [dup.telefono, surv.id]);
          if (!surv.notas && dup.notas) await cli.query('UPDATE contactos SET notas = $1 WHERE id = $2', [dup.notas, surv.id]);
          await cli.query('DELETE FROM contactos WHERE id = $1', [dup.id]);
          contactosUnificados++;
        }
        if ((surv.empresa_id ?? null) !== empresaFinal) {
          await cli.query('UPDATE contactos SET empresa_id = $1 WHERE id = $2', [empresaFinal, surv.id]);
        }
      }
    }

    // ---- Normalizar la escritura de todos los nombres que queden ----
    for (const t of ['empresas', 'contactos']) {
      const { rows } = await cli.query(`SELECT id, nombre FROM ${t}`);
      for (const r of rows) {
        const limpio = normalizarNombre(r.nombre);
        if (limpio && limpio !== r.nombre) await cli.query(`UPDATE ${t} SET nombre = $1 WHERE id = $2`, [limpio, r.id]);
      }
    }

    await cli.query('COMMIT');
    res.json({ ok: true, empresas: empresasUnificadas, contactos: contactosUnificados });
  } catch (e) {
    await cli.query('ROLLBACK');
    console.error('unificar:', e.message);
    res.status(500).json({ error: 'No se pudo unificar: ' + e.message });
  } finally {
    cli.release();
  }
});

export default router;

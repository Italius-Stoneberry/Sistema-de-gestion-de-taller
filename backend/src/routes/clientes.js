import { Router } from 'express';
import { query } from '../db.js';
import { requiereAuthOIngest } from '../auth.js';

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

export default router;

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, audit } from '../db.js';
import { requiereAuth, soloAdmin } from '../auth.js';

const router = Router();
router.use(requiereAuth, soloAdmin); // toda la gestión de usuarios es solo del admin

const ROLES = ['admin', 'gestor', 'consulta'];

// GET /api/usuarios
router.get('/', async (req, res) => {
  const { rows } = await query(
    'SELECT id, nombre, email, rol, activo, creado_en FROM usuarios ORDER BY id'
  );
  res.json(rows);
});

// POST /api/usuarios
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !b.email || !b.password) return res.status(400).json({ error: 'Faltan datos' });
  if (!ROLES.includes(b.rol)) return res.status(400).json({ error: 'Rol inválido' });
  const hash = await bcrypt.hash(b.password, 10);
  try {
    const { rows } = await query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, activo)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id, nombre, email, rol, activo, creado_en`,
      [b.nombre, String(b.email).toLowerCase(), hash, b.rol]
    );
    await audit(req.user.id, 'crear', 'usuario', rows[0].id, { email: rows[0].email });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese email ya está registrado' });
    throw e;
  }
});

// PUT /api/usuarios/:id  (nombre, rol, activo y opcionalmente password)
router.put('/:id', async (req, res) => {
  const b = req.body || {};
  if (b.rol && !ROLES.includes(b.rol)) return res.status(400).json({ error: 'Rol inválido' });
  let hash = null;
  if (b.password) hash = await bcrypt.hash(b.password, 10);
  const { rows } = await query(
    `UPDATE usuarios SET
       nombre = COALESCE($1, nombre),
       rol = COALESCE($2, rol),
       activo = COALESCE($3, activo),
       password_hash = COALESCE($4, password_hash)
     WHERE id = $5 RETURNING id, nombre, email, rol, activo, creado_en`,
    [b.nombre ?? null, b.rol ?? null, (b.activo === undefined ? null : !!b.activo), hash, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'editar', 'usuario', rows[0].id, null);
  res.json(rows[0]);
});

// DELETE /api/usuarios/:id  (no se puede eliminar a sí mismo)
router.delete('/:id', async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'No podés eliminar tu propio usuario' });
  const { rowCount } = await query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'No encontrado' });
  await audit(req.user.id, 'eliminar', 'usuario', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

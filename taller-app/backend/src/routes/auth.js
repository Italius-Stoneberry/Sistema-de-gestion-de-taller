import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, audit } from '../db.js';
import { firmarToken, requiereAuth } from '../auth.js';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });

  const { rows } = await query(
    'SELECT * FROM usuarios WHERE email = $1 AND activo = TRUE',
    [String(email).toLowerCase()]
  );
  const u = rows[0];
  if (!u) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

  await audit(u.id, 'login', 'usuario', u.id, null);
  const token = firmarToken(u);
  res.json({ token, user: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } });
});

// GET /api/auth/me
router.get('/me', requiereAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;

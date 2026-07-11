import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, audit } from '../db.js';
import { firmarToken, requiereAuth } from '../auth.js';

const router = Router();

// --- Freno anti fuerza bruta (en memoria): 10 intentos fallidos por IP cada 15 minutos. ---
const VENTANA_MS = 15 * 60 * 1000;
const MAX_INTENTOS = 10;
const intentos = new Map(); // ip -> { n, desde }

function limiteLogin(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || '?';
  const ahora = Date.now();
  const reg = intentos.get(ip);
  if (reg && ahora - reg.desde > VENTANA_MS) intentos.delete(ip);
  const actual = intentos.get(ip);
  if (actual && actual.n >= MAX_INTENTOS) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Esperá unos minutos y probá de nuevo.' });
  }
  req._ipLogin = ip;
  next();
}
function marcarFallo(ip) {
  const reg = intentos.get(ip) || { n: 0, desde: Date.now() };
  reg.n += 1;
  intentos.set(ip, reg);
}

// POST /api/auth/login
router.post('/login', limiteLogin, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });

  const { rows } = await query(
    'SELECT * FROM usuarios WHERE email = $1 AND activo = TRUE',
    [String(email).toLowerCase()]
  );
  const u = rows[0];
  if (!u) { marcarFallo(req._ipLogin); return res.status(401).json({ error: 'Email o contraseña incorrectos' }); }

  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) { marcarFallo(req._ipLogin); return res.status(401).json({ error: 'Email o contraseña incorrectos' }); }

  intentos.delete(req._ipLogin); // login exitoso: resetea el contador de esa IP
  await audit(u.id, 'login', 'usuario', u.id, null);
  const token = firmarToken(u);
  res.json({ token, user: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } });
});

// GET /api/auth/me
router.get('/me', requiereAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;

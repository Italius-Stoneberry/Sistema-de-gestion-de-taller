import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from './db.js';

// El arranque (index.js) aborta si JWT_SECRET falta o es corto: acá ya podemos confiar en que existe.
const SECRET = process.env.JWT_SECRET;

// Comparación en tiempo constante (evita timing attacks). Hashea ambos lados para
// poder comparar strings de distinta longitud sin revelar nada.
function igualSeguro(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function firmarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol },
    SECRET,
    { expiresIn: '12h' }
  );
}

// Middleware: exige un token válido y adjunta req.user.
// Además verifica contra la base que el usuario siga activo y toma el rol actual,
// para que desactivar un usuario o cambiarle el rol tenga efecto inmediato.
export async function requiereAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, SECRET);
    const { rows } = await query('SELECT rol, activo FROM usuarios WHERE id = $1', [payload.id]);
    if (!rows[0] || !rows[0].activo) return res.status(401).json({ error: 'Usuario inactivo' });
    req.user = { ...payload, rol: rows[0].rol };
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o vencida' });
  }
}

// Middleware factory: exige uno de los roles indicados.
export function requiereRol(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción' });
    }
    next();
  };
}

// Atajos de permisos
export const puedeEditar = requiereRol('admin', 'gestor'); // crear/editar
export const soloAdmin = requiereRol('admin');             // eliminar / usuarios

// Middleware para ingesta automática (n8n). Autentica por API key en vez de login.
// El "usuario" resultante no tiene id (creado_por queda NULL) y actúa con permisos de gestor.
export function requiereIngest(req, res, next) {
  const key = req.headers['x-api-key'];
  const esperada = process.env.INGEST_API_KEY;
  if (!esperada || !key || !igualSeguro(key, esperada)) {
    return res.status(401).json({ error: 'API key de ingesta inválida' });
  }
  req.user = { id: null, nombre: 'ingesta-ia', rol: 'gestor', ingest: true };
  next();
}

// Acepta sesión de usuario (JWT) O API key de ingesta. Para búsquedas que usan tanto la app como n8n.
export function requiereAuthOIngest(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key && process.env.INGEST_API_KEY && igualSeguro(key, process.env.INGEST_API_KEY)) {
    req.user = { id: null, nombre: 'ingesta-ia', rol: 'gestor', ingest: true };
    return next();
  }
  return requiereAuth(req, res, next);
}

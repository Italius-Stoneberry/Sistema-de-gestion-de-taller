import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'dev-inseguro-cambiar';

export function firmarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol },
    SECRET,
    { expiresIn: '12h' }
  );
}

// Middleware: exige un token válido y adjunta req.user.
export function requiereAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, SECRET);
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
  if (!esperada || key !== esperada) {
    return res.status(401).json({ error: 'API key de ingesta inválida' });
  }
  req.user = { id: null, nombre: 'ingesta-ia', rol: 'gestor', ingest: true };
  next();
}

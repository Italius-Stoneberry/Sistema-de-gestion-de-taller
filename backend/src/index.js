import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedAdmin } from './seed.js';
import { query } from './db.js';

// --- Chequeos de arranque: sin secretos reales, la app NO levanta. ---
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 ||
    process.env.JWT_SECRET === 'pega_aca_una_cadena_larga_y_aleatoria') {
  console.error('ERROR: JWT_SECRET faltante, corta (<32) o de ejemplo. Generala con: openssl rand -base64 48');
  process.exit(1);
}
if (process.env.INGEST_API_KEY === 'pega_aca_otra_cadena_larga_y_aleatoria') {
  console.error('ERROR: INGEST_API_KEY quedó con el valor de ejemplo. Generala con: openssl rand -hex 32');
  process.exit(1);
}

import authRoutes from './routes/auth.js';
import trabajosRoutes from './routes/trabajos.js';
import chequesRoutes from './routes/cheques.js';
import pagosRoutes from './routes/pagos.js';
import usuariosRoutes from './routes/usuarios.js';
import dashboardRoutes from './routes/dashboard.js';
import ingestaRoutes from './routes/ingesta.js';
import bandejaRoutes from './routes/bandeja.js';
import asistenteRoutes from './routes/asistente.js';
import empresasRoutes from './routes/empresas.js';
import contactosRoutes from './routes/contactos.js';
import clientesRoutes from './routes/clientes.js';
import comprasRoutes from './routes/compras.js';
import adjuntosRoutes from './routes/adjuntos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Red de seguridad: que un error suelto no tumbe todo el proceso.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', (e && e.message) || e));

const app = express();
// Límite alto para que entren fotos por media_base64 desde n8n (el default de 100kb las rechazaba).
app.use(express.json({ limit: '15mb' }));

// --- API ---
app.use('/api/auth', authRoutes);
app.use('/api/trabajos', trabajosRoutes);
app.use('/api/cheques', chequesRoutes);
app.use('/api/pagos', pagosRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/ingesta', ingestaRoutes);
app.use('/api/bandeja', bandejaRoutes);
app.use('/api/asistente', asistenteRoutes);
app.use('/api/empresas', empresasRoutes);
app.use('/api/contactos', contactosRoutes);
app.use('/api/clientes', clientesRoutes);
app.use('/api/compras', comprasRoutes);
app.use('/api/adjuntos', adjuntosRoutes);
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Frontend estático (sin diseño, para reemplazar más adelante) ---
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
// Cualquier otra ruta devuelve la app (navegación por el frontend)
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const PORT = Number(process.env.PORT) || 3000;

// Mantenimiento liviano: borra contextos de conversación del asistente sin uso hace 30 días.
async function limpiarConversaciones() {
  try {
    const r = await query(`DELETE FROM conversaciones WHERE actualizado_en < now() - interval '30 days'`);
    if (r.rowCount) console.log(`Limpieza: ${r.rowCount} conversación(es) viejas eliminadas`);
  } catch (e) { console.error('limpieza conversaciones:', e.message); }
}

async function main() {
  // Reintenta la conexión/seed por si la base tarda en levantar.
  for (let i = 0; i < 10; i++) {
    try {
      await seedAdmin();
      break;
    } catch (e) {
      console.log(`Esperando a la base de datos... (${e.message})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  limpiarConversaciones();
  setInterval(limpiarConversaciones, 24 * 60 * 60 * 1000);
  app.listen(PORT, () => console.log(`Taller app escuchando en el puerto ${PORT}`));
}

main();

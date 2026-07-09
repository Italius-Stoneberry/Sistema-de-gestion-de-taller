import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedAdmin } from './seed.js';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

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
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Frontend estático (sin diseño, para reemplazar más adelante) ---
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
// Cualquier otra ruta devuelve la app (navegación por el frontend)
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const PORT = Number(process.env.PORT) || 3000;

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
  app.listen(PORT, () => console.log(`Taller app escuchando en el puerto ${PORT}`));
}

main();

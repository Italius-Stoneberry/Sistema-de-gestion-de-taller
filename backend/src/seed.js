import bcrypt from 'bcryptjs';
import { query } from './db.js';

// Crea el usuario administrador inicial si todavía no existe ningún usuario.
export async function seedAdmin() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) return;

  const nombre = process.env.ADMIN_NOMBRE || 'Administrador';
  const email = (process.env.ADMIN_EMAIL || 'admin@taller.local').toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || 'admin1234';
  const hash = await bcrypt.hash(pass, 10);

  await query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol, activo)
     VALUES ($1,$2,$3,'admin',TRUE)`,
    [nombre, email, hash]
  );
  console.log(`Usuario admin inicial creado: ${email}`);
}

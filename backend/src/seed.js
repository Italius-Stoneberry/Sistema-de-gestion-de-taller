import bcrypt from 'bcryptjs';
import { query } from './db.js';

// Crea el usuario administrador inicial si todavía no existe ningún usuario.
export async function seedAdmin() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) return;

  const nombre = process.env.ADMIN_NOMBRE || 'Administrador';
  const email = (process.env.ADMIN_EMAIL || 'admin@taller.local').toLowerCase();
  const pass = process.env.ADMIN_PASSWORD;

  // Sin contraseña real no se crea nada: mejor no arrancar que arrancar con una clave conocida.
  const PLACEHOLDERS = ['cambiar_en_el_primer_ingreso', 'admin1234', 'admin', 'password'];
  if (!pass || pass.length < 8 || PLACEHOLDERS.includes(pass.toLowerCase())) {
    console.error('ERROR: ADMIN_PASSWORD faltante, corta (<8) o de ejemplo. Configurala en el .env y volvé a levantar.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(pass, 10);
  await query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol, activo)
     VALUES ($1,$2,$3,'admin',TRUE)`,
    [nombre, email, hash]
  );
  console.log(`Usuario admin inicial creado: ${email}`);
}

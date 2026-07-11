import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { query, audit } from '../db.js';
import { requiereAuth, puedeEditar } from '../auth.js';

const router = Router();
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
router.use(requiereAuth);

// GET /api/adjuntos?entidad=trabajo&entidad_id=5  -> lista de adjuntos de esa entidad
router.get('/', async (req, res) => {
  const { entidad, entidad_id } = req.query;
  if (!entidad || !entidad_id) return res.status(400).json({ error: 'Faltan entidad y entidad_id' });
  const { rows } = await query(
    'SELECT id, entidad, entidad_id, mime, descripcion, origen, creado_en FROM adjuntos WHERE entidad=$1 AND entidad_id=$2 ORDER BY creado_en',
    [entidad, entidad_id]
  );
  res.json(rows);
});

// GET /api/adjuntos/:id/archivo  -> devuelve el archivo (se pide por fetch con token y se muestra como blob)
router.get('/:id/archivo', async (req, res) => {
  const { rows } = await query('SELECT archivo, mime FROM adjuntos WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  const abs = path.resolve(UPLOADS_DIR, rows[0].archivo);
  if (!abs.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(abs)) return res.status(404).json({ error: 'Archivo no disponible' });
  if (rows[0].mime) res.type(rows[0].mime);
  fs.createReadStream(abs).pipe(res);
});

// DELETE /api/adjuntos/:id
router.delete('/:id', puedeEditar, async (req, res) => {
  const { rows } = await query('DELETE FROM adjuntos WHERE id=$1 RETURNING archivo', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
  const abs = path.resolve(UPLOADS_DIR, rows[0].archivo);
  if (abs.startsWith(path.resolve(UPLOADS_DIR))) fs.promises.unlink(abs).catch(() => {});
  await audit(req.user.id, 'eliminar', 'adjunto', Number(req.params.id), null);
  res.json({ ok: true });
});

export default router;

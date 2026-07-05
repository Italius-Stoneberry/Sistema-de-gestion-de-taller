import { Router } from 'express';
import { query } from '../db.js';
import { requiereAuth } from '../auth.js';

const router = Router();
router.use(requiereAuth);

// GET /api/bandeja -> todo lo cargado por IA que está pendiente de revisar
router.get('/', async (req, res) => {
  const trabajos = await query(`SELECT * FROM trabajos WHERE revisado = FALSE ORDER BY creado_en DESC`);
  const cheques = await query(`SELECT * FROM cheques WHERE revisado = FALSE ORDER BY creado_en DESC`);
  const pagos = await query(`SELECT * FROM pagos_servicios WHERE revisado = FALSE ORDER BY creado_en DESC`);
  res.json({
    total: trabajos.rowCount + cheques.rowCount + pagos.rowCount,
    trabajos: trabajos.rows,
    cheques: cheques.rows,
    pagos: pagos.rows,
  });
});

export default router;

import { Router } from 'express';
import { query } from '../db.js';
import { requiereAuth } from '../auth.js';

const router = Router();
router.use(requiereAuth);

// GET /api/dashboard  -> resumen para la pantalla principal
router.get('/', async (req, res) => {
  // Todas las consultas en paralelo: la pantalla tarda lo que la más lenta, no la suma.
  const [porEstado, porDisciplina, finalizados, chequesPendientes, chequesProximos, pagosPendientes] = await Promise.all([
    query(`SELECT estado, COUNT(*)::int AS n FROM trabajos GROUP BY estado`),
    query(`SELECT disciplina, COUNT(*)::int AS n FROM trabajos
     WHERE estado IN ('pedido','en_progreso','en_espera') GROUP BY disciplina`),
    query(`SELECT
       COUNT(*) FILTER (WHERE NOT pagado)::int    AS sin_cobrar,
       COUNT(*) FILTER (WHERE NOT facturado)::int AS sin_facturar,
       COALESCE(SUM(precio) FILTER (WHERE NOT pagado),0) AS monto_por_cobrar
     FROM trabajos WHERE estado = 'finalizado'`),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(importe),0) AS total
     FROM cheques WHERE estado = 'pendiente'`),
    query(`SELECT * FROM cheques
     WHERE estado = 'pendiente' AND fecha_cobro IS NOT NULL
       AND fecha_cobro <= CURRENT_DATE + INTERVAL '15 days'
     ORDER BY fecha_cobro ASC`),
    query(`SELECT * FROM pagos_servicios
     WHERE estado = 'pendiente'
     ORDER BY fecha_vencimiento NULLS LAST`),
  ]);

  res.json({
    trabajos_por_estado: porEstado.rows,
    en_curso_por_disciplina: porDisciplina.rows,
    finalizados: finalizados.rows[0],
    cheques_pendientes: chequesPendientes.rows[0],
    cheques_proximos: chequesProximos.rows,
    pagos_pendientes: pagosPendientes.rows,
  });
});

export default router;

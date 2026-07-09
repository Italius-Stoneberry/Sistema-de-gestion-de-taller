import { Router } from 'express';
import { query } from '../db.js';
import { requiereAuth } from '../auth.js';

const router = Router();
router.use(requiereAuth);

// GET /api/dashboard  -> resumen para la pantalla principal
router.get('/', async (req, res) => {
  const porEstado = await query(
    `SELECT estado, COUNT(*)::int AS n FROM trabajos GROUP BY estado`
  );
  const porDisciplina = await query(
    `SELECT disciplina, COUNT(*)::int AS n FROM trabajos
     WHERE estado IN ('pedido','en_progreso','en_espera') GROUP BY disciplina`
  );
  const finalizados = await query(
    `SELECT
       COUNT(*) FILTER (WHERE NOT pagado)::int    AS sin_cobrar,
       COUNT(*) FILTER (WHERE NOT facturado)::int AS sin_facturar,
       COALESCE(SUM(precio) FILTER (WHERE NOT pagado),0) AS monto_por_cobrar
     FROM trabajos WHERE estado = 'finalizado'`
  );
  const chequesPendientes = await query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(importe),0) AS total
     FROM cheques WHERE estado = 'pendiente'`
  );
  const chequesProximos = await query(
    `SELECT * FROM cheques
     WHERE estado = 'pendiente' AND fecha_cobro IS NOT NULL
       AND fecha_cobro <= CURRENT_DATE + INTERVAL '15 days'
     ORDER BY fecha_cobro ASC`
  );
  const pagosPendientes = await query(
    `SELECT * FROM pagos_servicios
     WHERE estado = 'pendiente'
     ORDER BY fecha_vencimiento NULLS LAST`
  );

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

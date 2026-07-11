// Constantes de dominio compartidas por rutas, ingesta y asistente.
// ÚNICA fuente de verdad: si agregás una disciplina o estado, tocá solo acá
// (y la migración SQL del CHECK correspondiente).
export const DISCIPLINAS = ['laser', 'serigrafia', 'ploteo', 'impresion'];
export const ESTADOS = ['cotizar', 'presupuestado', 'pedido', 'en_progreso', 'en_espera', 'finalizado'];
export const CHEQUE_TIPOS = ['recibido', 'emitido'];
export const CHEQUE_MODALIDADES = ['fisico', 'electronico'];
export const CHEQUE_ESTADOS = ['pendiente', 'cobrado', 'depositado', 'rechazado'];
export const PAGO_ESTADOS = ['pendiente', 'pagado'];

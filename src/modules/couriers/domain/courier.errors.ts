export type CourierErrorCode = 'VALIDATION_ERROR' | 'COURIER_NOT_FOUND' | 'ROUTE_NOT_FOUND' | 'DATA_CONFLICT' | 'PERSISTENCE_UNAVAILABLE';
const messages: Record<CourierErrorCode, string> = {
  VALIDATION_ERROR: 'Entrada inválida.',
  COURIER_NOT_FOUND: 'El repartidor no existe.',
  ROUTE_NOT_FOUND: 'La ruta no existe.',
  DATA_CONFLICT: 'El repartidor o la ruta no permiten esta operación.',
  PERSISTENCE_UNAVAILABLE: 'Persistencia no disponible. Consulte el estado antes de repetir una asignación.',
};
export class CourierError extends Error {
  constructor(readonly code: CourierErrorCode, message = messages[code]) { super(message); }
}

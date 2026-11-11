export type DeliveryErrorCode =
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN'
  | 'ORDER_NOT_FOUND'
  | 'ROUTE_NOT_FOUND'
  | 'DATA_CONFLICT'
  | 'PERSISTENCE_UNAVAILABLE';

const messages: Record<DeliveryErrorCode, string> = {
  VALIDATION_ERROR: 'Entrada inválida.',
  FORBIDDEN: 'El actor no está autorizado para ejecutar esta operación.',
  ORDER_NOT_FOUND: 'El pedido no existe.',
  ROUTE_NOT_FOUND: 'La ruta no existe.',
  DATA_CONFLICT: 'El estado o versión actual no permiten esta operación.',
  PERSISTENCE_UNAVAILABLE: 'Persistencia no disponible. Consulte el estado antes de reintentar.',
};

export class DeliveryError extends Error {
  constructor(
    readonly code: DeliveryErrorCode,
    message = messages[code],
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

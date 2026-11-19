export type StoreErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PRODUCT_NOT_FOUND'
  | 'CATEGORY_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'ZONE_NOT_FOUND'
  | 'IMAGE_NOT_FOUND'
  | 'DUPLICATE_SKU'
  | 'DUPLICATE_CATEGORY'
  | 'VERSION_CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'ORDER_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'OPERATION_IN_PROGRESS'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PERSISTENCE_UNAVAILABLE';

const DEFAULT_MESSAGES: Record<StoreErrorCode, string> = {
  VALIDATION_ERROR: 'Los datos enviados no son válidos.',
  UNAUTHORIZED: 'Se requiere autenticación válida.',
  FORBIDDEN: 'No tienes permisos para realizar esta acción.',
  PRODUCT_NOT_FOUND: 'El producto no existe.',
  CATEGORY_NOT_FOUND: 'La categoría no existe.',
  ORDER_NOT_FOUND: 'El pedido no existe.',
  ZONE_NOT_FOUND: 'La zona no existe.',
  IMAGE_NOT_FOUND: 'La imagen no existe.',
  DUPLICATE_SKU: 'Ya existe un producto con ese SKU.',
  DUPLICATE_CATEGORY: 'Ya existe una categoría con ese nombre.',
  VERSION_CONFLICT: 'Otra persona modificó este registro antes que tú. Recarga y vuelve a intentarlo.',
  INSUFFICIENT_STOCK: 'El stock disponible no alcanza para ese ajuste.',
  ORDER_CONFLICT: 'No se pudo completar el pedido: revisa los productos y la franja de entrega.',
  IDEMPOTENCY_KEY_REUSED: 'Esa Idempotency-Key ya se usó con un pedido distinto. Usa una clave nueva.',
  OPERATION_IN_PROGRESS: 'La operación sigue en proceso. Vuelve a intentarlo en unos segundos.',
  FILE_TOO_LARGE: 'La imagen supera el límite permitido.',
  UNSUPPORTED_MEDIA_TYPE: 'Solo se aceptan imágenes JPEG o PNG.',
  PERSISTENCE_UNAVAILABLE: 'El servicio no está disponible temporalmente.',
};

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message?: string,
    /** Datos adicionales que sí pueden verse en la respuesta (por ejemplo, qué productos no tienen stock). */
    readonly details?: unknown,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'StoreError';
  }
}

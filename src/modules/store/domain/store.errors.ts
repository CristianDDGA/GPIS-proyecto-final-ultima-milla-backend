export type StoreErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PRODUCT_NOT_FOUND'
  | 'CATEGORY_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'ZONE_NOT_FOUND'
  | 'ZONE_NOT_OPERATIONAL'
  | 'PIN_REQUIRED'
  | 'ZONE_OUT_OF_COVERAGE'
  | 'IMAGE_NOT_FOUND'
  | 'DUPLICATE_SKU'
  | 'DUPLICATE_CATEGORY'
  | 'VERSION_CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'ORDER_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ORDER_NOT_CANCELLABLE'
  | 'ORDER_NOT_RESCHEDULABLE'
  | 'MAX_DELIVERY_ATTEMPTS'
  | 'SCHEDULE_CONFLICT'
  | 'STALE_ORDER'
  | 'COLLECTION_AMOUNT_MISMATCH'
  | 'COLLECTION_REQUIRED'
  | 'NOT_A_STORE_ORDER'
  | 'ADDRESS_NOT_FOUND'
  | 'ADDRESS_LIMIT'
  | 'DUPLICATE_ADDRESS'
  | 'ALREADY_SETTLED'
  | 'NOTHING_TO_SETTLE'
  | 'COURIER_NOT_FOUND'
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
  ZONE_NOT_OPERATIONAL: 'Esta zona aún no tiene cobertura definida y no recibe pedidos.',
  PIN_REQUIRED: 'Marca tu ubicación en el mapa para saber si llegamos a esa dirección.',
  ZONE_OUT_OF_COVERAGE: 'Aún no llegamos a esta dirección: el punto está fuera de la zona elegida.',
  IMAGE_NOT_FOUND: 'La imagen no existe.',
  DUPLICATE_SKU: 'Ya existe un producto con ese SKU.',
  DUPLICATE_CATEGORY: 'Ya existe una categoría con ese nombre.',
  VERSION_CONFLICT: 'Otra persona modificó este registro antes que tú. Recarga y vuelve a intentarlo.',
  INSUFFICIENT_STOCK: 'El stock disponible no alcanza para ese ajuste.',
  ORDER_CONFLICT: 'No se pudo completar el pedido: revisa los productos y la franja de entrega.',
  IDEMPOTENCY_KEY_REUSED: 'Esa Idempotency-Key ya se usó con un pedido distinto. Usa una clave nueva.',
  ORDER_NOT_CANCELLABLE: 'El pedido ya no se puede cancelar: está recogido, en camino o cerrado.',
  ORDER_NOT_RESCHEDULABLE: 'Solo se puede reprogramar un pedido con entrega fallida cuya ruta ya se cerró.',
  MAX_DELIVERY_ATTEMPTS: 'El pedido ya agotó sus 3 intentos de entrega: solo puede cancelarse.',
  SCHEDULE_CONFLICT: 'La franja elegida no está disponible. Elige otra.',
  STALE_ORDER: 'El pedido cambió o ya no está en tu ruta. Actualiza tu lista y vuelve a intentarlo.',
  COLLECTION_AMOUNT_MISMATCH: 'El monto cobrado debe ser exactamente el total del pedido.',
  COLLECTION_REQUIRED: 'Un pedido de tienda se entrega registrando el cobro.',
  NOT_A_STORE_ORDER: 'Este pedido no es de la tienda y se entrega sin cobro.',
  ADDRESS_NOT_FOUND: 'La dirección no existe.',
  ADDRESS_LIMIT: 'Solo puedes guardar hasta 10 direcciones.',
  DUPLICATE_ADDRESS: 'Ya tienes una dirección con ese nombre.',
  ALREADY_SETTLED: 'La caja de ese conductor ya se rindió para esa fecha.',
  NOTHING_TO_SETTLE: 'Ese conductor no tiene cobros en esa fecha.',
  COURIER_NOT_FOUND: 'El conductor no existe.',
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

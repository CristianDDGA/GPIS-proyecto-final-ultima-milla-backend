import { getSqlState } from '../../../../shared/sql-state.js';
import { StoreError } from '../../domain/store.errors.js';

// Traduce errores de PostgreSQL a errores de negocio de la tienda. Ningún mensaje, SQL ni credencial del
// controlador llega al cliente: solo se usan para reconocer qué regla falló.

function errorText(error: unknown): string {
  if (error === null || typeof error !== 'object') return '';
  const candidate = error as { message?: unknown; meta?: unknown };
  const parts: string[] = [];
  if (typeof candidate.message === 'string') parts.push(candidate.message);
  try {
    if (candidate.meta !== undefined) parts.push(JSON.stringify(candidate.meta));
  } catch {
    // meta circular: se ignora
  }
  return parts.join(' ').slice(0, 4_000);
}

const VALIDATION_STATES = new Set(['22023', '22P02', '22007', '22004', '22003', '22001', '23502']);

export function mapStoreSqlError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const state = getSqlState(error);
  const text = errorText(error);
  switch (state) {
    case '23505':
      if (text.includes('products_sku_idx')) return new StoreError('DUPLICATE_SKU');
      if (text.includes('categories_name_key_idx')) return new StoreError('DUPLICATE_CATEGORY');
      return new StoreError('ORDER_CONFLICT');
    case 'LG404':
      return new StoreError(text.includes('CATEGORY_NOT_FOUND') ? 'CATEGORY_NOT_FOUND' : 'PRODUCT_NOT_FOUND');
    case 'LG409':
      return new StoreError('VERSION_CONFLICT');
    case 'LG412':
      return new StoreError('INSUFFICIENT_STOCK');
    case '42501':
      return new StoreError('FORBIDDEN');
    case '23503':
      if (text.includes('ZONE_NOT_FOUND')) return new StoreError('ZONE_NOT_FOUND');
      if (text.includes('CUSTOMER_USER_NOT_FOUND')) return new StoreError('FORBIDDEN', 'Solo los clientes activos pueden hacer pedidos de la tienda.');
      return new StoreError('CATEGORY_NOT_FOUND');
    case '23514':
      if (text.includes('IDEMPOTENCY_PAYLOAD_CONFLICT')) return new StoreError('IDEMPOTENCY_KEY_REUSED');
      return new StoreError('VALIDATION_ERROR', 'Los datos no cumplen las reglas de la tienda; revisa nombres, precios y cantidades.');
    case '55P03':
      return new StoreError('OPERATION_IN_PROGRESS');
    default:
      if (state !== undefined && VALIDATION_STATES.has(state)) return new StoreError('VALIDATION_ERROR');
      return new StoreError('PERSISTENCE_UNAVAILABLE');
  }
}

/** Interbloqueo o fallo de serialización: la operación se puede repetir sin riesgo porque es idempotente. */
export function isRetryableSqlError(error: unknown): boolean {
  const state = getSqlState(error);
  return state === '40P01' || state === '40001';
}

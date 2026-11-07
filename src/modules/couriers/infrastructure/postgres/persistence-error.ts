import { CourierError } from '../../domain/courier.errors.js';
export function persistenceError(error: unknown): never {
  if (error instanceof CourierError) throw error;
  const detail = error as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null;
  const codes = [detail?.code, detail?.meta?.code, detail?.meta?.driverAdapterError?.cause?.originalCode];
  if (codes.some(code => ['23505', '23514', '23503', '40001', '40P01', 'P2002', 'P2003'].includes(String(code)))) throw new CourierError('DATA_CONFLICT');
  throw new CourierError('PERSISTENCE_UNAVAILABLE');
}

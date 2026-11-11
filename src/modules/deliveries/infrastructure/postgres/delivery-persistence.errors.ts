import { DeliveryError } from '../../domain/delivery.errors.js';

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly meta?: {
    readonly code?: unknown;
    readonly driverAdapterError?: {
      readonly cause?: {
        readonly originalCode?: unknown;
      };
    };
  };
}

const FORBIDDEN_CODES = new Set(['42501']);
const VALIDATION_CODES = new Set(['22004', '22023', '22P02', '22003']);
const CONFLICT_CODES = new Set([
  '23505',
  '23514',
  '23503',
  '40001',
  '40P01',
  '55P03',
  'P2002',
  'P2003',
]);

export function mapDeliveryPersistenceError(error: unknown): never {
  if (error instanceof DeliveryError) {
    throw error;
  }

  const detail = error as PostgresErrorShape | null;
  const codes = [
    detail?.code,
    detail?.meta?.code,
    detail?.meta?.driverAdapterError?.cause?.originalCode,
  ].map(value => String(value ?? ''));

  if (codes.some(code => FORBIDDEN_CODES.has(code))) {
    throw new DeliveryError('FORBIDDEN');
  }
  if (codes.some(code => VALIDATION_CODES.has(code))) {
    throw new DeliveryError('VALIDATION_ERROR');
  }
  if (codes.some(code => CONFLICT_CODES.has(code))) {
    throw new DeliveryError('DATA_CONFLICT');
  }

  throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
}

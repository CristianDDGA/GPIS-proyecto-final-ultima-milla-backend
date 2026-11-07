import {
  RouteConflictError,
  RouteIntegrityError,
  RouteNotFoundError,
  RoutePersistenceUnavailableError,
  RouteValidationError,
} from '../../domain/route.errors.js';

const VALIDATION_CODES = new Set(['22004', '22007', '22008', '22023', '22P02']);
// Payload conflict for a reused key, unfinished operation, lock wait, serialization or integrity rule.
const CONFLICT_CODES = new Set(['P2002', '23505', '23503', '23514', '40001', '40P01', '55P03']);

export function throwRoutePersistenceError(error: unknown): never {
  if (
    error instanceof RouteValidationError || error instanceof RouteNotFoundError || error instanceof RouteConflictError ||
    error instanceof RoutePersistenceUnavailableError || error instanceof RouteIntegrityError
  ) {
    throw error;
  }
  const details = error as {
    code?: unknown;
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } };
    cause?: { originalCode?: unknown; code?: unknown };
  } | null;
  const cause = details?.meta?.driverAdapterError?.cause ?? details?.cause;
  const codes = [details?.code, details?.meta?.code, cause?.originalCode, cause?.code].filter(
    (code): code is string => typeof code === 'string'
  );
  if (codes.some((code) => VALIDATION_CODES.has(code))) {
    throw new RouteValidationError('Los parámetros de planificación no cumplen las reglas de la base.');
  }
  if (codes.some((code) => CONFLICT_CODES.has(code))) {
    throw new RouteConflictError(
      'La solicitud entra en conflicto con una planificación existente; si reutilizas la clave, envía los mismos datos.'
    );
  }
  // SQLSTATE, driver messages, SQL text and credentials never cross this boundary.
  throw new RoutePersistenceUnavailableError();
}

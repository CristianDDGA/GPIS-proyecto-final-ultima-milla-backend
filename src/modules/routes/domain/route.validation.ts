import { RouteValidationError } from './route.errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export function validateUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    throw new RouteValidationError(`El campo ${field} debe ser un UUID válido.`);
  }
  return value.trim().toLowerCase();
}

export function validateServiceDate(value: unknown, field = 'serviceDate'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new RouteValidationError(`El campo ${field} debe tener formato YYYY-MM-DD.`);
  }
  const date = value.trim();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (date.startsWith('0000-') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RouteValidationError(`El campo ${field} no corresponde a una fecha del calendario.`);
  }
  return date;
}

// Body values must already be JSON integers; strings such as "4" are rejected.
export function validateCapacityLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > POSTGRES_INTEGER_MAX) {
    throw new RouteValidationError('El campo capacityLimit debe ser un entero positivo.');
  }
  return value;
}

function parseQueryInteger(value: string | undefined, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,10}$/.test(value)) {
    throw new RouteValidationError(`El parámetro ${field} debe ser un entero entre ${minimum} y ${maximum}.`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new RouteValidationError(`El parámetro ${field} debe ser un entero entre ${minimum} y ${maximum}.`);
  }
  return parsed;
}

export function validatePagination(rawLimit?: string, rawOffset?: string): { limit: number; offset: number } {
  return {
    limit: parseQueryInteger(rawLimit, 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT),
    offset: parseQueryInteger(rawOffset, 'offset', 0, POSTGRES_INTEGER_MAX, 0),
  };
}

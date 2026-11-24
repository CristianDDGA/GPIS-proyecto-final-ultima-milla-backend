import { CourierError } from './courier.errors.js';
import { validatePersonName } from '../../../shared/text-validation.js';
import { MAX_ORDERS_PER_ROUTE } from '../../../shared/delivery-limits.js';

export interface Courier {
  readonly id: string;
  readonly displayName: string;
  readonly maxOrdersPerTrip: number;
  readonly isEnabled: boolean;
  readonly isAvailable: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export function isEligible(courier: Courier, hasActiveRoute: boolean): boolean {
  return courier.isEnabled && courier.isAvailable && !hasActiveRoute;
}
export function validateRegistration(displayName: unknown, capacity: unknown) {
  if (typeof displayName !== 'string' || !displayName.trim()) {
    throw new CourierError('VALIDATION_ERROR', 'El nombre es obligatorio.');
  }
  const name = validatePersonName(displayName, 'El nombre');
  if (!name.ok) throw new CourierError('VALIDATION_ERROR', name.reason);
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_ORDERS_PER_ROUTE) {
    throw new CourierError('VALIDATION_ERROR', `La capacidad debe ser un entero entre 1 y ${MAX_ORDERS_PER_ROUTE}.`);
  }
  return { displayName: name.value, maxOrdersPerTrip: capacity };
}
export function validateId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new CourierError('VALIDATION_ERROR', 'Se requiere un UUID válido.');
  }
  return value.toLowerCase();
}

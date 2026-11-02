import { CourierError } from './courier.errors.js';

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
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > 2147483647) {
    throw new CourierError('VALIDATION_ERROR', 'La capacidad debe ser un entero positivo de 32 bits.');
  }
  return { displayName: displayName.trim(), maxOrdersPerTrip: capacity };
}
export function validateId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new CourierError('VALIDATION_ERROR', 'Se requiere un UUID válido.');
  }
  return value.toLowerCase();
}

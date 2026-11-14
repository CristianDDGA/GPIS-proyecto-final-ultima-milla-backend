import { AuthError } from './auth.errors.js';

export const APP_ROLES = ['personal', 'repartidor', 'cliente'] as const;
export type AppRole = typeof APP_ROLES[number];
export type PublicRole = 'admin' | 'repartidor' | 'cliente';

export interface AuthUser {
  readonly id: string;
  readonly authSubject: string;
  readonly email: string;
  readonly role: AppRole;
  readonly publicRole: PublicRole;
  readonly displayName: string | null;
  readonly isActive: boolean;
  readonly courierId: string | null;
}

export interface AuthUserRecord extends AuthUser {
  readonly passwordHash: string | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function toPublicRole(role: AppRole): PublicRole {
  return role === 'personal' ? 'admin' : role;
}

export function validateRole(value: unknown): AppRole {
  if (value === 'admin' || value === 'personal') return 'personal';
  if (value === 'repartidor' || value === 'cliente') return value;
  throw new AuthError('VALIDATION_ERROR', 'Rol no válido. Usa admin, repartidor o cliente.');
}

export function validateEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthError('VALIDATION_ERROR', 'El correo electrónico es obligatorio.');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254 || !EMAIL_REGEX.test(normalized)) {
    throw new AuthError('VALIDATION_ERROR', 'El formato del correo electrónico no es válido.');
  }
  return normalized;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new AuthError('VALIDATION_ERROR', 'La contraseña debe tener entre 8 y 128 caracteres.');
  }
  return value;
}

export function validateDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AuthError('VALIDATION_ERROR', 'El nombre debe ser texto válido.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 120) {
    throw new AuthError('VALIDATION_ERROR', 'El nombre no puede superar 120 caracteres.');
  }
  return trimmed;
}

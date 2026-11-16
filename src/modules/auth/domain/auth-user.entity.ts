import { AuthError } from './auth.errors.js';
import { validateNewEmail as validateNewEmailText, validatePersonName } from '../../../shared/text-validation.js';

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
  /** true cuando el correo está verificado (por código, por un administrador, en modo demo o por ser anterior). */
  readonly emailVerified: boolean;
}

export type EmailVerifiedVia = 'code' | 'admin' | 'legacy' | 'demo';

export interface AuthUserRecord extends AuthUser {
  readonly passwordHash: string | null;
  /** null mientras el correo no esté verificado. Solo 'code' prueba que el usuario controla el correo. */
  readonly emailVerifiedVia: EmailVerifiedVia | null;
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

// Alta de usuarios: correo ASCII estricto. El login usa validateEmail para no bloquear cuentas antiguas.
export function validateNewEmail(value: unknown): string {
  const result = validateNewEmailText(value);
  if (!result.ok) throw new AuthError('VALIDATION_ERROR', result.reason);
  return result.value;
}

// Alta de usuarios: el nombre es opcional, pero si se envía solo admite letras (sin números ni emojis).
export function validateNewDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  const result = validatePersonName(value, 'El nombre');
  if (!result.ok) throw new AuthError('VALIDATION_ERROR', result.reason);
  return result.value;
}

/** Código de un solo uso enviado por correo: exactamente 6 dígitos. */
export function validateOneTimeCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) {
    throw new AuthError('VALIDATION_ERROR', 'El código debe tener exactamente 6 dígitos.');
  }
  return value.trim();
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

export type AuthErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'EMAIL_ALREADY_EXISTS'
  | 'EMAIL_NOT_VERIFIED'
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'CODE_LOCKED'
  | 'USER_NOT_FOUND'
  | 'USER_INACTIVE'
  | 'PERSISTENCE_UNAVAILABLE';

const DEFAULT_MESSAGES: Record<AuthErrorCode, string> = {
  VALIDATION_ERROR: 'Los datos de autenticación no son válidos.',
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  UNAUTHORIZED: 'Se requiere autenticación válida.',
  FORBIDDEN: 'No tienes permisos para realizar esta acción.',
  EMAIL_ALREADY_EXISTS: 'Ya existe una cuenta registrada con ese correo.',
  EMAIL_NOT_VERIFIED: 'Debes verificar tu correo electrónico antes de iniciar sesión.',
  INVALID_CODE: 'El código no es válido.',
  CODE_EXPIRED: 'El código ha caducado. Solicita uno nuevo.',
  CODE_LOCKED: 'Demasiados intentos fallidos. Solicita un código nuevo.',
  USER_NOT_FOUND: 'No existe el usuario indicado.',
  USER_INACTIVE: 'La cuenta de usuario está desactivada.',
  PERSISTENCE_UNAVAILABLE: 'El servicio de autenticación no está disponible temporalmente.',
};

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AuthError';
    this.code = code;
  }
}

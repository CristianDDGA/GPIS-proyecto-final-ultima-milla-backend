export type AuthErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'EMAIL_ALREADY_EXISTS'
  | 'USER_INACTIVE'
  | 'PERSISTENCE_UNAVAILABLE';

const DEFAULT_MESSAGES: Record<AuthErrorCode, string> = {
  VALIDATION_ERROR: 'Los datos de autenticación no son válidos.',
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  UNAUTHORIZED: 'Se requiere autenticación válida.',
  FORBIDDEN: 'No tienes permisos para realizar esta acción.',
  EMAIL_ALREADY_EXISTS: 'Ya existe una cuenta registrada con ese correo.',
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

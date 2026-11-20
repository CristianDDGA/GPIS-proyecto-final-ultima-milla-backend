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
  | 'ACCOUNT_LOCKED'
  | 'USER_NOT_FOUND'
  | 'USER_INACTIVE'
  | 'LAST_ADMIN'
  | 'USER_HAS_ACTIVE_ROUTE'
  | 'CANNOT_DEACTIVATE_SELF'
  | 'INVALID_GOOGLE_TOKEN'
  | 'GOOGLE_NOT_ENABLED'
  | 'GOOGLE_NOT_ALLOWED'
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
  ACCOUNT_LOCKED: 'Demasiados intentos fallidos. Intenta de nuevo más tarde.',
  USER_NOT_FOUND: 'No existe el usuario indicado.',
  USER_INACTIVE: 'La cuenta de usuario está desactivada.',
  LAST_ADMIN: 'No se puede desactivar al último administrador activo.',
  USER_HAS_ACTIVE_ROUTE: 'El repartidor tiene una ruta asignada o en curso. Reasigna o cierra la ruta antes de desactivarlo.',
  CANNOT_DEACTIVATE_SELF: 'No puedes desactivar tu propia cuenta.',
  INVALID_GOOGLE_TOKEN: 'No se pudo comprobar el inicio de sesión con Google. Inténtalo de nuevo.',
  GOOGLE_NOT_ENABLED: 'El inicio de sesión con Google no está habilitado.',
  GOOGLE_NOT_ALLOWED: 'Esta cuenta no puede entrar con Google.',
  PERSISTENCE_UNAVAILABLE: 'El servicio de autenticación no está disponible temporalmente.',
};

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Segundos que el cliente debe esperar (se envía como cabecera Retry-After). */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: AuthErrorCode, message?: string, retryAfterSeconds?: number) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AuthError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

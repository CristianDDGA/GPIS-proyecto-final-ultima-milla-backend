/**
 * Bloqueo temporal por cuenta tras varios inicios de sesión fallidos. La clave es el correo normalizado, exista o no
 * la cuenta, para que el bloqueo tampoco revele qué correos están registrados.
 */
export interface LoginAttemptStore {
  /** Segundos que faltan para que termine el bloqueo; 0 si la cuenta no está bloqueada. */
  lockedForSeconds(key: string): Promise<number>;
  recordFailure(key: string): Promise<void>;
  /** Tras un inicio de sesión correcto (clave válida) se olvidan los fallos. */
  reset(key: string): Promise<void>;
}

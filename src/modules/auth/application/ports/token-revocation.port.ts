export interface TokenSessionClaims {
  /** Usuario dueño del token. */
  readonly sub: string;
  /** Segundo (epoch) en que se emitió el token. */
  readonly iat: number;
}

export interface TokenRevocationStore {
  revoke(jti: string, expSeconds: number): Promise<void>;
  /**
   * true si el token fue revocado individualmente (logout) o, cuando se pasan los claims, si se emitió
   * antes del último cierre de sesiones del usuario (cambio o recuperación de clave).
   */
  isRevoked(jti: string, claims?: TokenSessionClaims): Promise<boolean>;
  /** Invalida todos los tokens del usuario emitidos antes de atSeconds. */
  revokeUserSessions(userId: string, atSeconds: number): Promise<void>;
}

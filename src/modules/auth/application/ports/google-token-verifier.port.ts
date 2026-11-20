/** Lo que Google asegura sobre la persona una vez comprobado el token. */
export interface GoogleIdentity {
  /** Identificador estable de la cuenta de Google (claim "sub"). No cambia aunque la persona cambie de correo. */
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
}

export interface GoogleTokenVerifier {
  /** Comprueba firma, emisor, audiencia (nuestro Client ID) y vigencia. Lanza AuthError INVALID_GOOGLE_TOKEN si algo falla. */
  verify(idToken: string): Promise<GoogleIdentity>;
}

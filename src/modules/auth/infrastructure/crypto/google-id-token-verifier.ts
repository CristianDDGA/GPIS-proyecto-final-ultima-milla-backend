import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';
import { AuthError } from '../../domain/auth.errors.js';
import type { GoogleIdentity, GoogleTokenVerifier } from '../../application/ports/google-token-verifier.port.js';

// Verifica el "ID token" que entrega Google Identity Services, sin dependencias: firma RS256 con las claves públicas
// de Google (JWKS), emisor, audiencia (nuestro Client ID), vigencia y correo verificado.

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4_096;
const DEFAULT_KEYS_MAX_AGE_SECONDS = 3_600;
const MIN_REFETCH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface GoogleKeySet {
  readonly keys: readonly (JsonWebKey & { kid?: string })[];
  /** Segundos que se puede reutilizar el conjunto (de la cabecera Cache-Control de Google). */
  readonly maxAgeSeconds: number;
}

export interface GoogleVerifierOptions {
  readonly clientId: string;
  /** Pruebas: sustituye la descarga de las claves. */
  readonly fetchKeys?: () => Promise<GoogleKeySet>;
  readonly now?: () => number;
}

async function downloadKeys(): Promise<GoogleKeySet> {
  const response = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Google respondió ${response.status} al pedir las claves.`);
  const body = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error('Respuesta de claves de Google inválida.');
  const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1];
  return { keys: body.keys as GoogleKeySet['keys'], maxAgeSeconds: maxAge ? Number(maxAge) : DEFAULT_KEYS_MAX_AGE_SECONDS };
}

function invalid(detail?: string): AuthError {
  return new AuthError('INVALID_GOOGLE_TOKEN', detail);
}

function decodePart(part: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('no es un objeto');
    return parsed as Record<string, unknown>;
  } catch {
    throw invalid();
  }
}

export class GoogleIdTokenVerifier implements GoogleTokenVerifier {
  private readonly clientId: string;
  private readonly fetchKeys: () => Promise<GoogleKeySet>;
  private readonly now: () => number;
  private cache = new Map<string, KeyObject>();
  private expiresAt = 0;
  private lastFetch = 0;

  constructor(options: GoogleVerifierOptions) {
    if (options.clientId.trim() === '') throw new Error('GOOGLE_CLIENT_ID no puede estar vacío.');
    this.clientId = options.clientId.trim();
    this.fetchKeys = options.fetchKeys ?? downloadKeys;
    this.now = options.now ?? Date.now;
  }

  private async refresh(): Promise<void> {
    const set = await this.fetchKeys();
    const next = new Map<string, KeyObject>();
    for (const jwk of set.keys) {
      if (jwk.kty === 'RSA' && typeof jwk.kid === 'string') next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
    this.cache = next;
    this.lastFetch = this.now();
    this.expiresAt = this.lastFetch + Math.max(60, set.maxAgeSeconds) * 1000;
  }

  /** Devuelve la clave del token; si no la conoce (rotación de Google) vuelve a descargar, como máximo una vez por minuto. */
  private async keyFor(kid: string): Promise<KeyObject> {
    if (this.now() >= this.expiresAt) await this.refresh();
    let key = this.cache.get(kid);
    if (!key && this.now() - this.lastFetch >= MIN_REFETCH_INTERVAL_MS) {
      await this.refresh();
      key = this.cache.get(kid);
    }
    if (!key) throw invalid();
    return key;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_TOKEN_LENGTH) throw invalid();
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((part) => part === '')) throw invalid();
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodePart(headerPart);
    if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') throw invalid();

    let key: KeyObject;
    try {
      key = await this.keyFor(header['kid']);
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error;
      // No se pudieron obtener las claves de Google: no es culpa del usuario ni se debe aceptar el token.
      throw new AuthError('PERSISTENCE_UNAVAILABLE', 'No se pudo comprobar el inicio de sesión con Google. Inténtalo de nuevo.');
    }
    const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'utf8');
    if (!verifySignature('RSA-SHA256', signed, key, Buffer.from(signaturePart, 'base64url'))) throw invalid();

    const claims = decodePart(payloadPart);
    const nowSeconds = Math.floor(this.now() / 1000);
    const exp = claims['exp'];
    const iat = claims['iat'];
    if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < nowSeconds) throw invalid('El inicio de sesión con Google caducó. Inténtalo de nuevo.');
    if (typeof iat === 'number' && iat - CLOCK_SKEW_SECONDS > nowSeconds) throw invalid();
    if (typeof claims['iss'] !== 'string' || !ISSUERS.has(claims['iss'])) throw invalid();
    if (claims['aud'] !== this.clientId) throw invalid();
    const sub = claims['sub'];
    const email = claims['email'];
    if (typeof sub !== 'string' || sub === '' || typeof email !== 'string' || email === '') throw invalid();
    const emailVerified = claims['email_verified'] === true || claims['email_verified'] === 'true';
    const name = typeof claims['name'] === 'string' && claims['name'].trim() !== '' ? claims['name'].trim() : null;
    return { sub, email, emailVerified, name };
  }
}

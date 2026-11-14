import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../../domain/auth.errors.js';
import type { AppRole } from '../../domain/auth-user.entity.js';
import type { TokenClaims, TokenPayload, TokenService } from '../../application/ports/token-service.port.js';

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const VALID_ROLES = new Set<string>(['personal', 'repartidor', 'cliente']);

export class HmacJwtTokenService implements TokenService {
  constructor(
    private readonly secret: string,
    private readonly expiresInSeconds = 86_400,
  ) {
    if (secret.length < 16) {
      throw new Error('JWT_SECRET debe tener al menos 16 caracteres.');
    }
  }

  sign(claims: TokenClaims): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: TokenPayload = {
      ...claims,
      iat: now,
      exp: now + this.expiresInSeconds,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${JWT_HEADER}.${encodedPayload}`;
    const signature = createHmac('sha256', this.secret).update(signingInput).digest('base64url');
    return `${signingInput}.${signature}`;
  }

  verify(token: string): TokenPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new AuthError('UNAUTHORIZED', 'Token de acceso con formato inválido.');
    }
    const [header, encodedPayload, signature] = parts;
    if (!header || !encodedPayload || !signature) {
      throw new AuthError('UNAUTHORIZED', 'Token de acceso incompleto.');
    }
    const signingInput = `${header}.${encodedPayload}`;
    const expectedSig = createHmac('sha256', this.secret).update(signingInput).digest();
    let actualSig: Buffer;
    try {
      actualSig = Buffer.from(signature, 'base64url');
    } catch {
      throw new AuthError('UNAUTHORIZED', 'Firma de token inválida.');
    }
    if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
      throw new AuthError('UNAUTHORIZED', 'Firma de token inválida.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      throw new AuthError('UNAUTHORIZED', 'Carga útil del token inválida.');
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AuthError('UNAUTHORIZED', 'Carga útil del token inválida.');
    }

    const record = parsed as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof record['sub'] !== 'string' ||
      typeof record['authSubject'] !== 'string' ||
      typeof record['role'] !== 'string' ||
      !VALID_ROLES.has(record['role']) ||
      typeof record['iat'] !== 'number' ||
      typeof record['exp'] !== 'number'
    ) {
      throw new AuthError('UNAUTHORIZED', 'Reclamos de token inválidos.');
    }
    if (record['exp'] <= now) {
      throw new AuthError('UNAUTHORIZED', 'El token de acceso ha expirado.');
    }

    return {
      sub: record['sub'],
      authSubject: record['authSubject'],
      role: record['role'] as AppRole,
      courierId: typeof record['courierId'] === 'string' ? record['courierId'] : null,
      iat: record['iat'],
      exp: record['exp'],
    };
  }
}

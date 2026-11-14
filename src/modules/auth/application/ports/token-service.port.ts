import type { AppRole } from '../../domain/auth-user.entity.js';

export interface TokenClaims {
  readonly sub: string;
  readonly role: AppRole;
  readonly authSubject: string;
  readonly courierId: string | null;
}

export interface TokenPayload extends TokenClaims {
  readonly iat: number;
  readonly exp: number;
}

export interface TokenService {
  sign(claims: TokenClaims): string;
  verify(token: string): TokenPayload;
}

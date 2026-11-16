import type { TokenRevocationStore, TokenSessionClaims } from '../../application/ports/token-revocation.port.js';

export class InMemoryTokenRevocationStore implements TokenRevocationStore {
  private readonly revoked = new Map<string, number>();
  private readonly userCutoffs = new Map<string, number>();

  async revoke(jti: string, expSeconds: number): Promise<void> {
    this.revoked.set(jti, expSeconds);
  }

  async revokeUserSessions(userId: string, atSeconds: number): Promise<void> {
    this.userCutoffs.set(userId, Math.max(atSeconds, this.userCutoffs.get(userId) ?? 0));
  }

  async isRevoked(jti: string, claims?: TokenSessionClaims): Promise<boolean> {
    if (claims) {
      const cutoff = this.userCutoffs.get(claims.sub);
      if (cutoff !== undefined && claims.iat < cutoff) return true;
    }
    const exp = this.revoked.get(jti);
    if (exp === undefined) return false;
    if (exp <= Math.floor(Date.now() / 1000)) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }
}

import type { TokenRevocationStore } from '../../application/ports/token-revocation.port.js';

export class InMemoryTokenRevocationStore implements TokenRevocationStore {
  private readonly revoked = new Map<string, number>();

  async revoke(jti: string, expSeconds: number): Promise<void> {
    this.revoked.set(jti, expSeconds);
  }

  async isRevoked(jti: string): Promise<boolean> {
    const exp = this.revoked.get(jti);
    if (exp === undefined) return false;
    if (exp <= Math.floor(Date.now() / 1000)) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }
}

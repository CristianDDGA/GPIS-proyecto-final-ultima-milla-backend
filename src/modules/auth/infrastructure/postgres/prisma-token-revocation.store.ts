import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { TokenRevocationStore } from '../../application/ports/token-revocation.port.js';
import { AuthError } from '../../domain/auth.errors.js';

export class PrismaTokenRevocationStore implements TokenRevocationStore {
  /** Cache en memoria para evitar ir a PostgreSQL en cada peticion autenticada. */
  private readonly cache = new Map<string, boolean>();

  constructor(private readonly database: PrismaDatabaseClient) {}

  async revoke(jti: string, expSeconds: number): Promise<void> {
    try {
      const expiresAt = new Date(expSeconds * 1000).toISOString();
      await this.database.$queryRaw`
        SELECT count(*)::integer AS "done"
        FROM logistica.revoke_token(${jti}::text, ${expiresAt}::timestamptz)
      `;
      this.cache.set(jti, true);
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    const cached = this.cache.get(jti);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const rows = await this.database.$queryRaw<Array<{ revoked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM logistica.revoked_tokens WHERE jti = ${jti}::text
        ) AS revoked
      `;
      const revoked = rows[0]?.revoked === true;
      this.cache.set(jti, revoked);
      return revoked;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }
}

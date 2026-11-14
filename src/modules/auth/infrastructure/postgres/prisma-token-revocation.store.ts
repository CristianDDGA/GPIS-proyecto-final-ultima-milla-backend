import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { TokenRevocationStore } from '../../application/ports/token-revocation.port.js';
import { AuthError } from '../../domain/auth.errors.js';

export class PrismaTokenRevocationStore implements TokenRevocationStore {
  constructor(private readonly database: PrismaDatabaseClient) {}

  async revoke(jti: string, expSeconds: number): Promise<void> {
    try {
      const expiresAt = new Date(expSeconds * 1000).toISOString();
      await this.database.$queryRaw`
        SELECT logistica.revoke_token(${jti}::text, ${expiresAt}::timestamptz)
      `;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    try {
      const rows = await this.database.$queryRaw<Array<{ revoked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM logistica.revoked_tokens WHERE jti = ${jti}::text
        ) AS revoked
      `;
      return rows[0]?.revoked === true;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }
}

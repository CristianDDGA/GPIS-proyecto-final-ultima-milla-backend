import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { TokenRevocationStore, TokenSessionClaims } from '../../application/ports/token-revocation.port.js';
import { AuthError } from '../../domain/auth.errors.js';

// Tiempo máximo que otra instancia tarda en enterarse de un cierre de sesiones; esta instancia lo aplica al instante.
const CUTOFF_TTL_MS = 15_000;

interface CutoffEntry {
  readonly cutoff: number | null;
  readonly fetchedAt: number;
}

export class PrismaTokenRevocationStore implements TokenRevocationStore {
  /** Cache en memoria para evitar ir a PostgreSQL en cada peticion autenticada. */
  private readonly cache = new Map<string, boolean>();
  private readonly cutoffs = new Map<string, CutoffEntry>();

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

  // La columna tokens_valid_after ya la actualizó la función SQL de cambio de clave; aquí solo se refresca la caché local.
  async revokeUserSessions(userId: string, atSeconds: number): Promise<void> {
    this.cutoffs.set(userId, { cutoff: atSeconds, fetchedAt: Date.now() });
  }

  async isRevoked(jti: string, claims?: TokenSessionClaims): Promise<boolean> {
    if (claims && (await this.issuedBeforeCutoff(claims))) return true;
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

  private async issuedBeforeCutoff(claims: TokenSessionClaims): Promise<boolean> {
    const known = this.cutoffs.get(claims.sub);
    if (known && Date.now() - known.fetchedAt < CUTOFF_TTL_MS) {
      return known.cutoff !== null && claims.iat < known.cutoff;
    }
    try {
      const rows = await this.database.$queryRaw<Array<{ cutoff: number | null }>>`
        SELECT floor(extract(epoch FROM tokens_valid_after))::float8 AS cutoff
        FROM logistica.app_users WHERE id = ${claims.sub}::uuid
      `;
      const raw = rows[0]?.cutoff;
      const cutoff = raw === null || raw === undefined ? null : Number(raw);
      this.cutoffs.set(claims.sub, { cutoff, fetchedAt: Date.now() });
      return cutoff !== null && claims.iat < cutoff;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }
}

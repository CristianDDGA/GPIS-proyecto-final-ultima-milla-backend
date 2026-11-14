import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import { AuthError } from '../../domain/auth.errors.js';
import { toPublicRole, type AppRole, type AuthUser, type AuthUserRecord } from '../../domain/auth-user.entity.js';
import type { AuthRepository, RegisterUserInput } from '../../application/ports/auth.repository.port.js';

interface UserRow {
  readonly id: string;
  readonly auth_subject: string;
  readonly email: string | null;
  readonly password_hash: string | null;
  readonly role: string;
  readonly display_name: string | null;
  readonly is_active: boolean;
  readonly courier_id: string | null;
}

function mapUser(row: UserRow): AuthUser {
  const role = row.role as AppRole;
  return {
    id: row.id,
    authSubject: row.auth_subject,
    email: row.email ?? row.auth_subject,
    role,
    publicRole: toPublicRole(role),
    displayName: row.display_name,
    isActive: row.is_active,
    courierId: row.courier_id,
  };
}

function mapRecord(row: UserRow): AuthUserRecord {
  return {
    ...mapUser(row),
    passwordHash: row.password_hash,
  };
}

function getSqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  if (typeof candidate.meta?.code === 'string') return candidate.meta.code;
  if (typeof candidate.code === 'string') return candidate.code;
  return undefined;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly database: PrismaDatabaseClient) {}

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    try {
      const rows = await this.database.$queryRaw<UserRow[]>`
          SELECT u.id, u.auth_subject, u.email, u.password_hash, u.role, u.display_name, u.is_active, c.id AS courier_id
          FROM logistica.app_users u
          LEFT JOIN logistica.couriers c ON c.user_id = u.id
          WHERE lower(u.email) = lower(${email})
          LIMIT 1
        `;
      const row = rows[0];
      return row ? mapRecord(row) : null;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async findById(id: string): Promise<AuthUser | null> {
    try {
      const rows = await this.database.$queryRaw<UserRow[]>`
          SELECT u.id, u.auth_subject, u.email, u.password_hash, u.role, u.display_name, u.is_active, c.id AS courier_id
          FROM logistica.app_users u
          LEFT JOIN logistica.couriers c ON c.user_id = u.id
          WHERE u.id = ${id}::uuid
          LIMIT 1
        `;
      const row = rows[0];
      return row ? mapUser(row) : null;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async registerUser(input: RegisterUserInput): Promise<AuthUser> {
    try {
      const rows = await this.database.$queryRaw<Array<{ id: string }>>`
          SELECT logistica.register_app_user(
            ${input.authSubject}::text,
            ${input.email}::text,
            ${input.passwordHash}::text,
            ${input.role}::text,
            ${input.displayName}::text
          ) AS id
        `;
      const createdId = rows[0]?.id;
      if (!createdId) {
        throw new AuthError('PERSISTENCE_UNAVAILABLE');
      }
      const user = await this.findById(createdId);
      if (!user) {
        throw new AuthError('PERSISTENCE_UNAVAILABLE');
      }
      return user;
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error;
      const sqlState = getSqlState(error);
      if (sqlState === '23505' || sqlState === 'P2002') {
        throw new AuthError('EMAIL_ALREADY_EXISTS');
      }
      if (sqlState === '22023') {
        throw new AuthError('VALIDATION_ERROR');
      }
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }
}

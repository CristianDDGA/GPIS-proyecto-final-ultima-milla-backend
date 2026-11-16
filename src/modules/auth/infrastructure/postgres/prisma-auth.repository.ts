import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import { AuthError } from '../../domain/auth.errors.js';
import {
  toPublicRole,
  type AppRole,
  type AuthUser,
  type AuthUserRecord,
  type EmailVerifiedVia,
} from '../../domain/auth-user.entity.js';
import type {
  AuthRepository,
  CodeCheckResult,
  CodeIssueResult,
  CodePurpose,
  RegisterUserInput,
} from '../../application/ports/auth.repository.port.js';

interface UserRow {
  readonly id: string;
  readonly auth_subject: string;
  readonly email: string | null;
  readonly password_hash: string | null;
  readonly role: string;
  readonly display_name: string | null;
  readonly is_active: boolean;
  readonly courier_id: string | null;
  readonly email_verified_via: string | null;
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
    emailVerified: row.email_verified_via !== null,
  };
}

function mapRecord(row: UserRow): AuthUserRecord {
  return {
    ...mapUser(row),
    passwordHash: row.password_hash,
    emailVerifiedVia: row.email_verified_via as EmailVerifiedVia | null,
  };
}

function getSqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  if (typeof candidate.meta?.code === 'string') return candidate.meta.code;
  if (typeof candidate.code === 'string') return candidate.code;
  return undefined;
}

const CODE_RESULTS: ReadonlySet<string> = new Set(['OK', 'INVALID', 'EXPIRED', 'LOCKED']);

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly database: PrismaDatabaseClient) {}

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    try {
      const rows = await this.database.$queryRaw<UserRow[]>`
          SELECT u.id, u.auth_subject, u.email, u.password_hash, u.role, u.display_name, u.is_active,
                 u.email_verified_via, c.id AS courier_id
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
    const record = await this.findRecordById(id);
    if (!record) return null;
    const { passwordHash: _passwordHash, emailVerifiedVia: _via, ...user } = record;
    return user;
  }

  async findRecordById(id: string): Promise<AuthUserRecord | null> {
    try {
      const rows = await this.database.$queryRaw<UserRow[]>`
          SELECT u.id, u.auth_subject, u.email, u.password_hash, u.role, u.display_name, u.is_active,
                 u.email_verified_via, c.id AS courier_id
          FROM logistica.app_users u
          LEFT JOIN logistica.couriers c ON c.user_id = u.id
          WHERE u.id = ${id}::uuid
          LIMIT 1
        `;
      const row = rows[0];
      return row ? mapRecord(row) : null;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async registerUser(input: RegisterUserInput): Promise<AuthUser> {
    try {
      const rows =
        input.verification === 'pending'
          ? await this.database.$queryRaw<Array<{ id: string }>>`
              SELECT logistica.register_app_user(
                ${input.authSubject}::text,
                ${input.email}::text,
                ${input.passwordHash}::text,
                ${input.role}::text,
                ${input.displayName}::text
              ) AS id
            `
          : await this.database.$queryRaw<Array<{ id: string }>>`
              SELECT logistica.register_trusted_app_user(
                ${input.authSubject}::text,
                ${input.email}::text,
                ${input.passwordHash}::text,
                ${input.role}::text,
                ${input.displayName}::text,
                ${input.verification}::text
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

  async issueEmailCode(userId: string, purpose: CodePurpose, codeHash: string, ttlSeconds: number): Promise<CodeIssueResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.issue_email_code(${userId}::uuid, ${purpose}::text, ${codeHash}::text, ${ttlSeconds}::integer) AS result
      `;
      return rows[0]?.result === 'COOLDOWN' ? 'COOLDOWN' : 'OK';
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async confirmEmail(userId: string, codeHash: string): Promise<CodeCheckResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.confirm_email(${userId}::uuid, ${codeHash}::text) AS result
      `;
      return toCodeResult(rows[0]?.result);
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async resetPasswordWithCode(userId: string, codeHash: string, newPasswordHash: string): Promise<CodeCheckResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.reset_password_with_code(${userId}::uuid, ${codeHash}::text, ${newPasswordHash}::text) AS result
      `;
      return toCodeResult(rows[0]?.result);
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async setPassword(userId: string, newPasswordHash: string): Promise<boolean> {
    try {
      const rows = await this.database.$queryRaw<Array<{ updated: boolean }>>`
        SELECT logistica.set_app_user_password(${userId}::uuid, ${newPasswordHash}::text) AS updated
      `;
      return rows[0]?.updated === true;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }
}

function toCodeResult(value: string | undefined): CodeCheckResult {
  if (value === undefined || !CODE_RESULTS.has(value)) throw new AuthError('PERSISTENCE_UNAVAILABLE');
  return value as CodeCheckResult;
}

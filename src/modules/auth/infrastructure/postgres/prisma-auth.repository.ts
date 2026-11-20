import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import { getSqlState } from '../../../../shared/sql-state.js';
import { AuthError } from '../../domain/auth.errors.js';
import {
  toPublicRole,
  type AdminUserView,
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
  GoogleLinkResult,
  RegisterUserInput,
  SetActiveResult,
  UserListFilter,
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

interface ListRow {
  readonly id: string;
  readonly auth_subject: string;
  readonly email: string | null;
  readonly role: string;
  readonly display_name: string | null;
  readonly is_active: boolean;
  readonly courier_id: string | null;
  readonly email_verified_via: string | null;
  readonly created_at: Date;
}

function mapListRow(row: ListRow): AdminUserView {
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
    emailVerifiedVia: row.email_verified_via as EmailVerifiedVia | null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SET_ACTIVE_RESULTS: ReadonlySet<string> = new Set(['OK', 'UNCHANGED', 'NOT_FOUND', 'LAST_ADMIN', 'HAS_ACTIVE_ROUTE']);
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

  async findByGoogleSub(sub: string): Promise<AuthUserRecord | null> {
    try {
      const rows = await this.database.$queryRaw<UserRow[]>`
          SELECT u.id, u.auth_subject, u.email, u.password_hash, u.role, u.display_name, u.is_active,
                 u.email_verified_via, c.id AS courier_id
          FROM logistica.app_users u
          LEFT JOIN logistica.couriers c ON c.user_id = u.id
          WHERE u.google_sub = ${sub}
          LIMIT 1
        `;
      const row = rows[0];
      return row ? mapRecord(row) : null;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async registerGoogleUser(input: { sub: string; email: string; displayName: string | null }): Promise<AuthUser> {
    try {
      const rows = await this.database.$queryRaw<Array<{ id: string }>>`
        SELECT logistica.register_google_user(${input.sub}::text, ${input.email}::text, ${input.displayName}::text) AS id
      `;
      const id = rows[0]?.id;
      const user = id ? await this.findById(id) : null;
      if (!user) throw new AuthError('PERSISTENCE_UNAVAILABLE');
      return user;
    } catch (error: unknown) {
      if (error instanceof AuthError) throw error;
      const sqlState = getSqlState(error);
      if (sqlState === '23505' || sqlState === 'P2002') throw new AuthError('EMAIL_ALREADY_EXISTS');
      if (sqlState === '22023') throw new AuthError('VALIDATION_ERROR');
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async linkGoogleAccount(userId: string, sub: string): Promise<GoogleLinkResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.link_google_account(${userId}::uuid, ${sub}::text) AS result
      `;
      const result = rows[0]?.result;
      if (result === 'OK' || result === 'SUB_IN_USE') return result;
      return 'NOT_ELIGIBLE';
    } catch (error: unknown) {
      // Dos cuentas intentando vincular la misma identidad a la vez: el índice único rechaza la segunda.
      if (getSqlState(error) === '23505') return 'SUB_IN_USE';
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

  async listUsers(filter: UserListFilter): Promise<{ items: readonly AdminUserView[]; total: number }> {
    const role = filter.role ?? null;
    const active = filter.isActive ?? null;
    const q = filter.q ?? null;
    try {
      const rows = await this.database.$queryRaw<ListRow[]>`
        SELECT u.id, u.auth_subject, u.email, u.role, u.display_name, u.is_active, u.email_verified_via,
               c.id AS courier_id, u.created_at
        FROM logistica.app_users u
        LEFT JOIN logistica.couriers c ON c.user_id = u.id
        WHERE (${role}::text IS NULL OR u.role = ${role}::text)
          AND (${active}::boolean IS NULL OR u.is_active = ${active}::boolean)
          AND (${q}::text IS NULL OR position(lower(${q}::text) in lower(coalesce(u.email, '') || ' ' || coalesce(u.display_name, ''))) > 0)
        ORDER BY u.created_at DESC, u.id
        LIMIT ${filter.limit}::integer OFFSET ${filter.offset}::integer
      `;
      const counts = await this.database.$queryRaw<Array<{ total: number }>>`
        SELECT count(*)::integer AS total
        FROM logistica.app_users u
        WHERE (${role}::text IS NULL OR u.role = ${role}::text)
          AND (${active}::boolean IS NULL OR u.is_active = ${active}::boolean)
          AND (${q}::text IS NULL OR position(lower(${q}::text) in lower(coalesce(u.email, '') || ' ' || coalesce(u.display_name, ''))) > 0)
      `;
      return { items: rows.map(mapListRow), total: Number(counts[0]?.total ?? 0) };
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async findUserView(id: string): Promise<AdminUserView | null> {
    try {
      const rows = await this.database.$queryRaw<ListRow[]>`
        SELECT u.id, u.auth_subject, u.email, u.role, u.display_name, u.is_active, u.email_verified_via,
               c.id AS courier_id, u.created_at
        FROM logistica.app_users u
        LEFT JOIN logistica.couriers c ON c.user_id = u.id
        WHERE u.id = ${id}::uuid
        LIMIT 1
      `;
      const row = rows[0];
      return row ? mapListRow(row) : null;
    } catch {
      throw new AuthError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async setUserActive(userId: string, active: boolean): Promise<SetActiveResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.set_app_user_active(${userId}::uuid, ${active}::boolean) AS result
      `;
      const result = rows[0]?.result;
      if (result === undefined || !SET_ACTIVE_RESULTS.has(result)) throw new AuthError('PERSISTENCE_UNAVAILABLE');
      return result as SetActiveResult;
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

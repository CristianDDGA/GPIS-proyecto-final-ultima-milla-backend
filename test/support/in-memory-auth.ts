import { randomUUID } from 'node:crypto';
import type {
  AuthRepository,
  CodeCheckResult,
  CodeIssueResult,
  CodePurpose,
  RegisterUserInput,
  SetActiveResult,
  UserListFilter,
} from '../../src/modules/auth/application/ports/auth.repository.port.js';
import type { EmailMessage, EmailSender } from '../../src/modules/auth/application/ports/email-sender.port.js';
import { toPublicRole, type AdminUserView, type AuthUser, type AuthUserRecord } from '../../src/modules/auth/domain/auth-user.entity.js';
import { AuthError } from '../../src/modules/auth/domain/auth.errors.js';

interface StoredCode {
  hash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
}

/** Réplica en memoria de la semántica SQL de 007_email_verification.sql (cooldown 60 s, 5 intentos, expiración). */
export class InMemoryAuthRepository implements AuthRepository {
  private readonly usersById = new Map<string, AuthUserRecord>();
  private readonly codes = new Map<string, StoredCode>();
  private readonly createdAt = new Map<string, number>();
  private readonly usersWithActiveRoute = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    const normalized = email.toLowerCase();
    for (const user of this.usersById.values()) {
      if (user.email.toLowerCase() === normalized) return user;
    }
    return null;
  }

  async findRecordById(id: string): Promise<AuthUserRecord | null> {
    return this.usersById.get(id) ?? null;
  }

  async findById(id: string): Promise<AuthUser | null> {
    const record = this.usersById.get(id);
    if (!record) return null;
    const { passwordHash: _passwordHash, emailVerifiedVia: _via, ...user } = record;
    return user;
  }

  async registerUser(input: RegisterUserInput): Promise<AuthUser> {
    if (await this.findByEmail(input.email)) {
      throw new AuthError('EMAIL_ALREADY_EXISTS');
    }
    const id = randomUUID();
    const verifiedVia = input.verification === 'pending' ? null : input.verification;
    const record: AuthUserRecord = {
      id,
      authSubject: input.authSubject,
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role,
      publicRole: toPublicRole(input.role),
      displayName: input.displayName,
      isActive: true,
      courierId: null,
      emailVerified: verifiedVia !== null,
      emailVerifiedVia: verifiedVia,
    };
    this.usersById.set(id, record);
    this.createdAt.set(id, this.now());
    return (await this.findById(id))!;
  }

  async issueEmailCode(userId: string, purpose: CodePurpose, codeHash: string, ttlSeconds: number): Promise<CodeIssueResult> {
    const key = `${userId}:${purpose}`;
    const existing = this.codes.get(key);
    if (existing && existing.sentAt > this.now() - 60_000) return 'COOLDOWN';
    this.codes.set(key, { hash: codeHash, expiresAt: this.now() + ttlSeconds * 1000, attempts: 0, sentAt: this.now() });
    return 'OK';
  }

  private consume(userId: string, purpose: CodePurpose, codeHash: string): CodeCheckResult {
    const key = `${userId}:${purpose}`;
    const stored = this.codes.get(key);
    if (!stored) return 'INVALID';
    if (stored.expiresAt <= this.now()) {
      this.codes.delete(key);
      return 'EXPIRED';
    }
    if (stored.hash !== codeHash) {
      if (stored.attempts + 1 >= 5) {
        this.codes.delete(key);
        return 'LOCKED';
      }
      stored.attempts += 1;
      return 'INVALID';
    }
    this.codes.delete(key);
    return 'OK';
  }

  async confirmEmail(userId: string, codeHash: string): Promise<CodeCheckResult> {
    const result = this.consume(userId, 'verify_email', codeHash);
    const record = this.usersById.get(userId);
    if (result === 'OK' && record && record.emailVerifiedVia === null) {
      this.usersById.set(userId, { ...record, emailVerified: true, emailVerifiedVia: 'code' });
    }
    return result;
  }

  async resetPasswordWithCode(userId: string, codeHash: string, newPasswordHash: string): Promise<CodeCheckResult> {
    const result = this.consume(userId, 'reset_password', codeHash);
    const record = this.usersById.get(userId);
    if (result === 'OK') {
      if (!record || !record.isActive) return 'INVALID';
      this.usersById.set(userId, { ...record, passwordHash: newPasswordHash });
    }
    return result;
  }

  async setPassword(userId: string, newPasswordHash: string): Promise<boolean> {
    const record = this.usersById.get(userId);
    if (!record || !record.isActive) return false;
    this.usersById.set(userId, { ...record, passwordHash: newPasswordHash });
    return true;
  }

  async listUsers(filter: UserListFilter): Promise<{ items: readonly AdminUserView[]; total: number }> {
    const needle = filter.q?.toLowerCase();
    const matching = [...this.usersById.values()]
      .filter((user) => (filter.role === undefined || user.role === filter.role)
        && (filter.isActive === undefined || user.isActive === filter.isActive)
        && (needle === undefined || `${user.email} ${user.displayName ?? ''}`.toLowerCase().includes(needle)))
      .sort((a, b) => (this.createdAt.get(b.id) ?? 0) - (this.createdAt.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .map((user) => this.toView(user));
    return { items: matching.slice(filter.offset, filter.offset + filter.limit), total: matching.length };
  }

  async findUserView(id: string): Promise<AdminUserView | null> {
    const record = this.usersById.get(id);
    return record ? this.toView(record) : null;
  }

  async setUserActive(userId: string, active: boolean): Promise<SetActiveResult> {
    const record = this.usersById.get(userId);
    if (!record) return 'NOT_FOUND';
    if (record.isActive === active) return 'UNCHANGED';
    if (!active) {
      if (record.role === 'personal' && ![...this.usersById.values()].some((user) => user.id !== userId && user.role === 'personal' && user.isActive)) {
        return 'LAST_ADMIN';
      }
      if (this.usersWithActiveRoute.has(userId)) return 'HAS_ACTIVE_ROUTE';
    }
    this.usersById.set(userId, { ...record, isActive: active });
    return 'OK';
  }

  private toView(record: AuthUserRecord): AdminUserView {
    const { passwordHash: _passwordHash, ...view } = record;
    return { ...view, createdAt: new Date(this.createdAt.get(record.id) ?? 0).toISOString() };
  }

  /** Utilidad de pruebas: desactiva una cuenta. */
  deactivate(userId: string): void {
    const record = this.usersById.get(userId);
    if (record) this.usersById.set(userId, { ...record, isActive: false });
  }

  /** Utilidad de pruebas: simula que el repartidor tiene una ruta asignada o en curso. */
  markActiveRoute(userId: string, hasRoute = true): void {
    if (hasRoute) this.usersWithActiveRoute.add(userId); else this.usersWithActiveRoute.delete(userId);
  }
}

/** Guarda los correos enviados para que las pruebas lean el código sin un SMTP real. */
export class CapturingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failWith: Error | null = null;

  async send(message: EmailMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }

  /** Código de 6 dígitos del último correo enviado a esa dirección. */
  lastCodeFor(email: string): string {
    const message = [...this.sent].reverse().find((item) => item.to === email);
    const code = message ? /Código: (\d{6})/.exec(message.text)?.[1] : undefined;
    if (!code) throw new Error(`No hay correo con código para ${email}.`);
    return code;
  }
}

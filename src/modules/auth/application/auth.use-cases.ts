import { randomUUID } from 'node:crypto';
import { AuthError } from '../domain/auth.errors.js';
import {
  validateEmail,
  validateNewDisplayName,
  validateNewEmail,
  validateOneTimeCode,
  validatePassword,
  validateRole,
  type AdminUserView,
  type AppRole,
  type AuthUser,
  validatePhone,
  type UserProfile,
} from '../domain/auth-user.entity.js';
import { validateNewPassword } from '../domain/password-policy.js';
import { buildCodeEmail } from './email-templates.js';
import { generateOneTimeCode, hashOneTimeCode } from '../infrastructure/crypto/one-time-code.js';
import type { AuthRepository, CodeCheckResult, CodePurpose, UserListFilter } from './ports/auth.repository.port.js';
import type { EmailSender } from './ports/email-sender.port.js';
import type { GoogleTokenVerifier } from './ports/google-token-verifier.port.js';
import type { LoginAttemptStore } from './ports/login-attempt.port.js';
import type { PasswordHasher } from './ports/password-hasher.port.js';
import { maskEmail, type SecurityEvent, type SecurityLog } from './ports/security-log.port.js';
import type { TokenRevocationStore } from './ports/token-revocation.port.js';
import type { TokenService } from './ports/token-service.port.js';

export interface AuthSessionResult {
  readonly token: string;
  readonly user: AuthUser;
}

/** El registro propio devuelve sesión (modo demo) o pide verificar el correo con un código. */
export type RegisterResult = AuthSessionResult | { readonly user: AuthUser; readonly verificationRequired: true };

export interface AuthUseCasesOptions {
  readonly emailSender: EmailSender;
  /** Bloqueo temporal por cuenta tras inicios de sesión fallidos. */
  readonly loginAttempts: LoginAttemptStore;
  /** Clave para hashear los códigos (ver deriveCodeKey). */
  readonly codeKey: string;
  /** false = modo demo: los clientes quedan verificados al registrarse y no se envía correo. */
  readonly emailVerificationRequired: boolean;
  readonly codeTtlSeconds?: number;
  readonly log?: (message: string) => void;
  /** Registro de eventos de seguridad (inicios de sesión, cambios de clave, altas y bajas). */
  readonly securityLog?: SecurityLog;
  /** Sin valor, el inicio de sesión con Google está deshabilitado (GOOGLE_NOT_ENABLED). */
  readonly googleVerifier?: GoogleTokenVerifier;
}

/** Quién ejecuta una acción administrativa. */
export interface AdminActor {
  readonly role: AppRole;
  readonly id?: string;
}

export interface UserListQuery {
  readonly role?: unknown;
  readonly isActive?: unknown;
  readonly q?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface UserListPage {
  readonly items: readonly AdminUserView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface AuthUseCases {
  registerCustomer(input: { email: unknown; password: unknown; displayName?: unknown }): Promise<RegisterResult>;
  registerByAdmin(
    actor: AdminActor,
    input: { email: unknown; password: unknown; role: unknown; displayName?: unknown },
  ): Promise<AuthUser>;
  login(input: { email: unknown; password: unknown }): Promise<AuthSessionResult>;
  /** Entra (o crea/vincula una cuenta de cliente) con un ID token de Google. */
  loginWithGoogle(input: { idToken: unknown }): Promise<AuthSessionResult>;
  verifyEmail(input: { email: unknown; code: unknown }): Promise<AuthSessionResult>;
  resendVerification(input: { email: unknown }): Promise<void>;
  forgotPassword(input: { email: unknown }): Promise<void>;
  resetPassword(input: { email: unknown; code: unknown; newPassword: unknown }): Promise<void>;
  changePassword(userId: string, input: { currentPassword: unknown; newPassword: unknown }): Promise<AuthSessionResult>;
  adminResetPassword(actor: AdminActor, userId: unknown, input: { newPassword: unknown }): Promise<void>;
  listUsers(actor: AdminActor, query: UserListQuery): Promise<UserListPage>;
  getUser(actor: AdminActor, userId: unknown): Promise<AdminUserView>;
  setUserActive(actor: AdminActor, userId: unknown, input: { isActive: unknown }): Promise<AdminUserView>;
  logout(jti: string, expSeconds: number): Promise<void>;
  getMe(userId: string): Promise<AuthUser>;
  getProfile(userId: string): Promise<UserProfile>;
  /** Cambia el nombre y/o el teléfono propios; lo que no se envía queda igual. */
  updateProfile(userId: string, input: Record<string, unknown>): Promise<UserProfile>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CODE_TTL_SECONDS = 900;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

function requireAdmin(actor: AdminActor, message: string): void {
  if (actor.role !== 'personal') throw new AuthError('FORBIDDEN', message);
}

function requireUserId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AuthError('VALIDATION_ERROR', 'El identificador de usuario no es válido.');
  }
  return value.toLowerCase();
}

function parseBoundedInteger(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AuthError('VALIDATION_ERROR', `${field} debe ser un entero entre ${min} y ${max}.`);
  }
  return parsed;
}

function parseUserListFilter(query: UserListQuery): UserListFilter {
  let isActive: boolean | undefined;
  if (query.isActive !== undefined) {
    if (query.isActive !== 'true' && query.isActive !== 'false') {
      throw new AuthError('VALIDATION_ERROR', 'isActive debe ser true o false.');
    }
    isActive = query.isActive === 'true';
  }
  let q: string | undefined;
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || query.q.length > MAX_SEARCH_LENGTH) {
      throw new AuthError('VALIDATION_ERROR', `q debe ser texto de hasta ${MAX_SEARCH_LENGTH} caracteres.`);
    }
    q = query.q.trim() === '' ? undefined : query.q.trim();
  }
  return {
    ...(query.role !== undefined ? { role: validateRole(query.role) } : {}),
    ...(isActive !== undefined ? { isActive } : {}),
    ...(q !== undefined ? { q } : {}),
    limit: parseBoundedInteger(query.limit, 'limit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    offset: parseBoundedInteger(query.offset, 'offset', 0, 0, 1_000_000),
  };
}

function codeFailure(result: Exclude<CodeCheckResult, 'OK'>): AuthError {
  if (result === 'EXPIRED') return new AuthError('CODE_EXPIRED');
  if (result === 'LOCKED') return new AuthError('CODE_LOCKED');
  return new AuthError('INVALID_CODE');
}

export function createAuthUseCases(
  repository: AuthRepository,
  hasher: PasswordHasher,
  tokens: TokenService,
  revocationStore: TokenRevocationStore,
  options: AuthUseCasesOptions,
): AuthUseCases {
  const ttlSeconds = options.codeTtlSeconds ?? DEFAULT_CODE_TTL_SECONDS;
  const log = options.log ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  const securityLog = options.securityLog;
  function audit(event: SecurityEvent): void {
    try { securityLog?.(event); } catch { /* el registro nunca rompe una petición */ }
  }

  function issueSession(user: AuthUser): AuthSessionResult {
    const token = tokens.sign({
      sub: user.id,
      role: user.role,
      authSubject: user.authSubject,
      courierId: user.courierId,
    });
    return { token, user };
  }

  function hashCode(userId: string, purpose: CodePurpose, code: string): string {
    return hashOneTimeCode(options.codeKey, userId, purpose, code);
  }

  // Genera, guarda (solo su hash) y envía un código. Nunca lanza: el llamador responde igual exista o no la cuenta,
  // y un fallo del SMTP no debe romper el registro (el usuario puede pedir otro código).
  async function sendCode(user: { id: string; email: string; displayName: string | null }, purpose: CodePurpose): Promise<void> {
    try {
      const code = generateOneTimeCode();
      const issued = await repository.issueEmailCode(user.id, purpose, hashCode(user.id, purpose, code), ttlSeconds);
      if (issued === 'COOLDOWN') return;
      await options.emailSender.send(
        buildCodeEmail({ to: user.email, purpose, code, ttlMinutes: Math.round(ttlSeconds / 60), displayName: user.displayName }),
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'error desconocido';
      log(`No se pudo enviar el código (${purpose}): ${reason}`);
    }
  }

  // Hash de una clave aleatoria, calculado una sola vez, para igualar el tiempo de login con un correo inexistente.
  let decoy: Promise<string> | undefined;
  function decoyHash(): Promise<string> {
    decoy ??= hasher.hash(randomUUID());
    return decoy;
  }

  async function invalidateSessions(userId: string): Promise<void> {
    await revocationStore.revokeUserSessions(userId, Math.floor(Date.now() / 1000));
  }

  return {
    async registerCustomer(input) {
      const email = validateNewEmail(input.email);
      const password = validateNewPassword(input.password, email);
      const displayName = validateNewDisplayName(input.displayName);
      const passwordHash = await hasher.hash(password);
      const verificationRequired = options.emailVerificationRequired;
      const user = await repository.registerUser({
        authSubject: email,
        email,
        passwordHash,
        role: 'cliente',
        displayName,
        verification: verificationRequired ? 'pending' : 'demo',
      });
      audit({ type: 'register', email: maskEmail(email), userId: user.id, detail: verificationRequired ? 'pending_verification' : 'demo' });
      if (!verificationRequired) return issueSession(user);
      await sendCode(user, 'verify_email');
      return { user, verificationRequired: true };
    },

    async registerByAdmin(actor, input) {
      if (actor.role !== 'personal') {
        throw new AuthError('FORBIDDEN', 'Solo un administrador puede crear usuarios con rol asignado.');
      }
      const email = validateNewEmail(input.email);
      const password = validateNewPassword(input.password, email);
      const role = validateRole(input.role);
      const displayName = validateNewDisplayName(input.displayName);
      const passwordHash = await hasher.hash(password);
      // Cuenta creada por un administrador: nace verificada (no depende de un correo real).
      const created = await repository.registerUser({
        authSubject: email,
        email,
        passwordHash,
        role,
        displayName,
        verification: 'admin',
      });
      audit({ type: 'user_created_by_admin', email: maskEmail(email), userId: created.id, ...(actor.id ? { actorId: actor.id } : {}), detail: role });
      return created;
    },

    async login(input) {
      const email = validateEmail(input.email);
      const password = validatePassword(input.password);
      // Bloqueo por cuenta: se comprueba antes de mirar la clave, exista o no el correo.
      const lockedFor = await options.loginAttempts.lockedForSeconds(email);
      if (lockedFor > 0) {
        audit({ type: 'login_locked', email: maskEmail(email) });
        throw new AuthError(
          'ACCOUNT_LOCKED',
          `Demasiados intentos fallidos. Intenta de nuevo en ${Math.ceil(lockedFor / 60)} minuto(s).`,
          lockedFor,
        );
      }
      const record = await repository.findByEmail(email);
      if (!record || !record.passwordHash) {
        // Se hace el mismo trabajo de hash que con una cuenta real: la duración no revela si el correo existe.
        await hasher.verify(password, await decoyHash());
        await options.loginAttempts.recordFailure(email);
        audit({ type: 'login_failed', email: maskEmail(email), detail: 'unknown_account' });
        throw new AuthError('INVALID_CREDENTIALS');
      }
      if (!record.isActive) {
        throw new AuthError('USER_INACTIVE');
      }
      const valid = await hasher.verify(password, record.passwordHash);
      if (!valid) {
        await options.loginAttempts.recordFailure(email);
        audit({ type: 'login_failed', email: maskEmail(email), userId: record.id, detail: 'wrong_password' });
        throw new AuthError('INVALID_CREDENTIALS');
      }
      await options.loginAttempts.reset(email);
      // Solo tras comprobar la clave: no revela a un tercero si un correo está sin verificar.
      if (record.emailVerifiedVia === null) {
        audit({ type: 'login_unverified', email: maskEmail(email), userId: record.id });
        throw new AuthError('EMAIL_NOT_VERIFIED');
      }
      const { passwordHash: _passwordHash, emailVerifiedVia: _via, ...user } = record;
      audit({ type: 'login_success', email: maskEmail(email), userId: record.id });
      return issueSession(user);
    },

    async loginWithGoogle(input) {
      const verifier = options.googleVerifier;
      if (!verifier) throw new AuthError('GOOGLE_NOT_ENABLED');
      if (typeof input.idToken !== 'string' || input.idToken.trim() === '') {
        throw new AuthError('VALIDATION_ERROR', 'El token de Google es obligatorio.');
      }
      const identity = await verifier.verify(input.idToken.trim());
      if (!identity.emailVerified) throw new AuthError('GOOGLE_NOT_ALLOWED', 'Google no confirma el correo de esa cuenta.');
      let email: string;
      try {
        email = validateNewEmail(identity.email);
      } catch {
        throw new AuthError('GOOGLE_NOT_ALLOWED', 'El correo de esa cuenta de Google no es admitido.');
      }
      const sessionFor = async (userId: string, detail: string): Promise<AuthSessionResult> => {
        const user = await repository.findById(userId);
        if (!user) throw new AuthError('PERSISTENCE_UNAVAILABLE');
        if (!user.isActive) throw new AuthError('USER_INACTIVE');
        audit({ type: 'login_success', email: maskEmail(email), userId: user.id, detail });
        return issueSession(user);
      };

      // 1) Cuenta ya vinculada a esta identidad de Google: entra con el rol que tenga hoy (un cliente aprobado como
      //    conductor conserva su vinculación). Un cambio de correo en Google no la afecta: se identifica por "sub".
      const linked = await repository.findByGoogleSub(identity.sub);
      if (linked) return sessionFor(linked.id, 'google');

      // 2) Ya existe una cuenta con ese correo: solo se vincula si es un cliente que confirmó su correo por código.
      const existing = await repository.findByEmail(email);
      if (existing) {
        const result = await repository.linkGoogleAccount(existing.id, identity.sub);
        if (result !== 'OK') {
          audit({ type: 'login_failed', email: maskEmail(email), userId: existing.id, detail: `google_${result.toLowerCase()}` });
          throw new AuthError(
            'GOOGLE_NOT_ALLOWED',
            'Esta cuenta no puede entrar con Google. Usa tu correo y contraseña (los administradores y conductores no usan Google).',
          );
        }
        audit({ type: 'google_linked', email: maskEmail(email), userId: existing.id });
        return sessionFor(existing.id, 'google_linked');
      }

      // 3) Cuenta nueva: cliente verificado por Google y sin contraseña.
      const displayName = ((): string | null => {
        try {
          return validateNewDisplayName(identity.name ?? undefined);
        } catch {
          return null; // el nombre de Google puede traer caracteres que no admitimos: se deja vacío
        }
      })();
      try {
        const user = await repository.registerGoogleUser({ sub: identity.sub, email, displayName });
        audit({ type: 'register', email: maskEmail(email), userId: user.id, detail: 'google' });
        return sessionFor(user.id, 'google_new');
      } catch (error: unknown) {
        // Dos primeras entradas a la vez: la otra ya creó la cuenta; se reutiliza.
        if (error instanceof AuthError && error.code === 'EMAIL_ALREADY_EXISTS') {
          const winner = await repository.findByGoogleSub(identity.sub);
          if (winner) return sessionFor(winner.id, 'google');
          throw new AuthError('GOOGLE_NOT_ALLOWED');
        }
        throw error;
      }
    },

    async verifyEmail(input) {
      const email = validateEmail(input.email);
      const code = validateOneTimeCode(input.code);
      const record = await repository.findByEmail(email);
      if (!record || !record.isActive || record.emailVerifiedVia !== null) {
        throw new AuthError('INVALID_CODE');
      }
      const result = await repository.confirmEmail(record.id, hashCode(record.id, 'verify_email', code));
      if (result !== 'OK') throw codeFailure(result);
      const user = await repository.findById(record.id);
      if (!user) throw new AuthError('PERSISTENCE_UNAVAILABLE');
      audit({ type: 'email_verified', email: maskEmail(email), userId: user.id });
      return issueSession(user);
    },

    async resendVerification(input) {
      const email = validateEmail(input.email);
      const record = await repository.findByEmail(email);
      if (record && record.isActive && record.role === 'cliente' && record.emailVerifiedVia === null) {
        await sendCode(record, 'verify_email');
      }
    },

    async forgotPassword(input) {
      const email = validateEmail(input.email);
      const record = await repository.findByEmail(email);
      // Solo si el usuario demostró controlar el correo con un código: un correo "verificado" por un
      // administrador o por el modo demo puede ser ficticio o ajeno.
      if (record && record.isActive && record.passwordHash && record.emailVerifiedVia === 'code') {
        await sendCode(record, 'reset_password');
      }
    },

    async resetPassword(input) {
      const email = validateEmail(input.email);
      const code = validateOneTimeCode(input.code);
      const password = validateNewPassword(input.newPassword, email);
      // El hash se calcula antes de buscar al usuario para que la duración no revele si el correo existe.
      const newHash = await hasher.hash(password);
      const record = await repository.findByEmail(email);
      if (!record || !record.isActive || record.emailVerifiedVia !== 'code') {
        throw new AuthError('INVALID_CODE');
      }
      const result = await repository.resetPasswordWithCode(record.id, hashCode(record.id, 'reset_password', code), newHash);
      if (result !== 'OK') throw codeFailure(result);
      await invalidateSessions(record.id);
      audit({ type: 'password_reset', email: maskEmail(email), userId: record.id });
    },

    async changePassword(userId, input) {
      if (typeof input.currentPassword !== 'string' || input.currentPassword.length === 0) {
        throw new AuthError('VALIDATION_ERROR', 'La contraseña actual es obligatoria.');
      }
      const record = await repository.findRecordById(userId);
      if (!record || !record.isActive || !record.passwordHash) {
        throw new AuthError('UNAUTHORIZED');
      }
      const newPassword = validateNewPassword(input.newPassword, record.email);
      if (!(await hasher.verify(input.currentPassword, record.passwordHash))) {
        throw new AuthError('VALIDATION_ERROR', 'La contraseña actual no es correcta.');
      }
      if (newPassword === input.currentPassword) {
        throw new AuthError('VALIDATION_ERROR', 'La nueva contraseña debe ser distinta de la actual.');
      }
      if (!(await repository.setPassword(userId, await hasher.hash(newPassword)))) {
        throw new AuthError('UNAUTHORIZED');
      }
      await invalidateSessions(userId);
      audit({ type: 'password_changed', email: maskEmail(record.email), userId });
      const { passwordHash: _passwordHash, emailVerifiedVia: _via, ...user } = record;
      // Las demás sesiones se cierran; esta recibe un token nuevo para no sacar al usuario de su dispositivo.
      return issueSession(user);
    },

    async adminResetPassword(actor, userId, input) {
      if (actor.role !== 'personal') {
        throw new AuthError('FORBIDDEN', 'Solo un administrador puede restablecer contraseñas.');
      }
      if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
        throw new AuthError('VALIDATION_ERROR', 'El identificador de usuario no es válido.');
      }
      const newPassword = validateNewPassword(input.newPassword);
      if (!(await repository.setPassword(userId.toLowerCase(), await hasher.hash(newPassword)))) {
        throw new AuthError('USER_NOT_FOUND');
      }
      await invalidateSessions(userId.toLowerCase());
      audit({ type: 'admin_password_reset', userId: userId.toLowerCase(), ...(actor.id ? { actorId: actor.id } : {}) });
    },

    async listUsers(actor, query) {
      requireAdmin(actor, 'Solo un administrador puede listar usuarios.');
      const filter = parseUserListFilter(query);
      const page = await repository.listUsers(filter);
      return { items: page.items, total: page.total, limit: filter.limit, offset: filter.offset };
    },

    async getUser(actor, userId) {
      requireAdmin(actor, 'Solo un administrador puede consultar usuarios.');
      const view = await repository.findUserView(requireUserId(userId));
      if (!view) throw new AuthError('USER_NOT_FOUND');
      return view;
    },

    async setUserActive(actor, userId, input) {
      requireAdmin(actor, 'Solo un administrador puede activar o desactivar usuarios.');
      const id = requireUserId(userId);
      if (typeof input.isActive !== 'boolean') {
        throw new AuthError('VALIDATION_ERROR', 'isActive debe ser true o false.');
      }
      if (!input.isActive && actor.id !== undefined && actor.id.toLowerCase() === id) {
        throw new AuthError('CANNOT_DEACTIVATE_SELF');
      }
      const result = await repository.setUserActive(id, input.isActive);
      if (result === 'NOT_FOUND') throw new AuthError('USER_NOT_FOUND');
      if (result === 'LAST_ADMIN') throw new AuthError('LAST_ADMIN');
      if (result === 'HAS_ACTIVE_ROUTE') throw new AuthError('USER_HAS_ACTIVE_ROUTE');
      if (result === 'OK') {
        // Al desactivar, la base ya fijó tokens_valid_after; aquí se refresca la caché local de esta instancia.
        if (!input.isActive) await invalidateSessions(id);
        audit({ type: input.isActive ? 'user_activated' : 'user_deactivated', userId: id, ...(actor.id ? { actorId: actor.id } : {}) });
      }
      const view = await repository.findUserView(id);
      if (!view) throw new AuthError('USER_NOT_FOUND');
      return view;
    },

    async logout(jti, expSeconds) {
      await revocationStore.revoke(jti, expSeconds);
    },

    async getMe(userId) {
      const user = await repository.findById(userId);
      if (!user) {
        throw new AuthError('UNAUTHORIZED');
      }
      if (!user.isActive) {
        throw new AuthError('USER_INACTIVE');
      }
      return user;
    },

    async getProfile(userId) {
      const profile = await repository.findProfile(userId);
      if (!profile) throw new AuthError('UNAUTHORIZED');
      return profile;
    },

    async updateProfile(userId, input) {
      const allowed = ['displayName', 'phone'];
      const unknownKey = Object.keys(input).find((key) => !allowed.includes(key));
      if (unknownKey !== undefined) throw new AuthError('VALIDATION_ERROR', `Campo no permitido: ${unknownKey}.`);
      if (!('displayName' in input) && !('phone' in input)) {
        throw new AuthError('VALIDATION_ERROR', 'Envía displayName, phone o ambos.');
      }
      const current = await repository.findProfile(userId);
      if (!current) throw new AuthError('UNAUTHORIZED');
      const displayName = 'displayName' in input ? validateNewDisplayName(input['displayName']) : current.displayName;
      const phone = 'phone' in input ? validatePhone(input['phone']) : current.phone;
      const saved = await repository.updateProfile(userId, { displayName, phone });
      if (!saved) throw new AuthError('USER_INACTIVE');
      const profile = await repository.findProfile(userId);
      if (!profile) throw new AuthError('UNAUTHORIZED');
      return profile;
    },
  };
}

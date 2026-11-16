import { randomUUID } from 'node:crypto';
import { AuthError } from '../domain/auth.errors.js';
import {
  validateEmail,
  validateNewDisplayName,
  validateNewEmail,
  validateOneTimeCode,
  validatePassword,
  validateRole,
  type AppRole,
  type AuthUser,
} from '../domain/auth-user.entity.js';
import { validateNewPassword } from '../domain/password-policy.js';
import { buildCodeEmail } from './email-templates.js';
import { generateOneTimeCode, hashOneTimeCode } from '../infrastructure/crypto/one-time-code.js';
import type { AuthRepository, CodeCheckResult, CodePurpose } from './ports/auth.repository.port.js';
import type { EmailSender } from './ports/email-sender.port.js';
import type { LoginAttemptStore } from './ports/login-attempt.port.js';
import type { PasswordHasher } from './ports/password-hasher.port.js';
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
}

export interface AuthUseCases {
  registerCustomer(input: { email: unknown; password: unknown; displayName?: unknown }): Promise<RegisterResult>;
  registerByAdmin(
    actor: { role: AppRole },
    input: { email: unknown; password: unknown; role: unknown; displayName?: unknown },
  ): Promise<AuthUser>;
  login(input: { email: unknown; password: unknown }): Promise<AuthSessionResult>;
  verifyEmail(input: { email: unknown; code: unknown }): Promise<AuthSessionResult>;
  resendVerification(input: { email: unknown }): Promise<void>;
  forgotPassword(input: { email: unknown }): Promise<void>;
  resetPassword(input: { email: unknown; code: unknown; newPassword: unknown }): Promise<void>;
  changePassword(userId: string, input: { currentPassword: unknown; newPassword: unknown }): Promise<AuthSessionResult>;
  adminResetPassword(actor: { role: AppRole }, userId: unknown, input: { newPassword: unknown }): Promise<void>;
  logout(jti: string, expSeconds: number): Promise<void>;
  getMe(userId: string): Promise<AuthUser>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CODE_TTL_SECONDS = 900;

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
      return repository.registerUser({
        authSubject: email,
        email,
        passwordHash,
        role,
        displayName,
        verification: 'admin',
      });
    },

    async login(input) {
      const email = validateEmail(input.email);
      const password = validatePassword(input.password);
      // Bloqueo por cuenta: se comprueba antes de mirar la clave, exista o no el correo.
      const lockedFor = await options.loginAttempts.lockedForSeconds(email);
      if (lockedFor > 0) {
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
        throw new AuthError('INVALID_CREDENTIALS');
      }
      if (!record.isActive) {
        throw new AuthError('USER_INACTIVE');
      }
      const valid = await hasher.verify(password, record.passwordHash);
      if (!valid) {
        await options.loginAttempts.recordFailure(email);
        throw new AuthError('INVALID_CREDENTIALS');
      }
      await options.loginAttempts.reset(email);
      // Solo tras comprobar la clave: no revela a un tercero si un correo está sin verificar.
      if (record.emailVerifiedVia === null) {
        throw new AuthError('EMAIL_NOT_VERIFIED');
      }
      const { passwordHash: _passwordHash, emailVerifiedVia: _via, ...user } = record;
      return issueSession(user);
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
  };
}

import { AuthError } from '../domain/auth.errors.js';
import {
  validateDisplayName,
  validateEmail,
  validatePassword,
  validateRole,
  type AppRole,
  type AuthUser,
} from '../domain/auth-user.entity.js';
import type { AuthRepository } from './ports/auth.repository.port.js';
import type { PasswordHasher } from './ports/password-hasher.port.js';
import type { TokenService } from './ports/token-service.port.js';

export interface AuthSessionResult {
  readonly token: string;
  readonly user: AuthUser;
}

export interface AuthUseCases {
  registerCustomer(input: { email: unknown; password: unknown; displayName?: unknown }): Promise<AuthSessionResult>;
  registerByAdmin(
    actor: { role: AppRole },
    input: { email: unknown; password: unknown; role: unknown; displayName?: unknown },
  ): Promise<AuthUser>;
  login(input: { email: unknown; password: unknown }): Promise<AuthSessionResult>;
  getMe(userId: string): Promise<AuthUser>;
}

export function createAuthUseCases(
  repository: AuthRepository,
  hasher: PasswordHasher,
  tokens: TokenService,
): AuthUseCases {
  function issueSession(user: AuthUser): AuthSessionResult {
    const token = tokens.sign({
      sub: user.id,
      role: user.role,
      authSubject: user.authSubject,
      courierId: user.courierId,
    });
    return { token, user };
  }

  return {
    async registerCustomer(input) {
      const email = validateEmail(input.email);
      const password = validatePassword(input.password);
      const displayName = validateDisplayName(input.displayName);
      const passwordHash = await hasher.hash(password);
      const user = await repository.registerUser({
        authSubject: email,
        email,
        passwordHash,
        role: 'cliente',
        displayName,
      });
      return issueSession(user);
    },

    async registerByAdmin(actor, input) {
      if (actor.role !== 'personal') {
        throw new AuthError('FORBIDDEN', 'Solo un administrador puede crear usuarios con rol asignado.');
      }
      const email = validateEmail(input.email);
      const password = validatePassword(input.password);
      const role = validateRole(input.role);
      const displayName = validateDisplayName(input.displayName);
      const passwordHash = await hasher.hash(password);
      return repository.registerUser({
        authSubject: email,
        email,
        passwordHash,
        role,
        displayName,
      });
    },

    async login(input) {
      const email = validateEmail(input.email);
      const password = validatePassword(input.password);
      const record = await repository.findByEmail(email);
      if (!record || !record.passwordHash) {
        throw new AuthError('INVALID_CREDENTIALS');
      }
      if (!record.isActive) {
        throw new AuthError('USER_INACTIVE');
      }
      const valid = await hasher.verify(password, record.passwordHash);
      if (!valid) {
        throw new AuthError('INVALID_CREDENTIALS');
      }
      const user: AuthUser = {
        id: record.id,
        authSubject: record.authSubject,
        email: record.email,
        role: record.role,
        publicRole: record.publicRole,
        displayName: record.displayName,
        isActive: record.isActive,
        courierId: record.courierId,
      };
      return issueSession(user);
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

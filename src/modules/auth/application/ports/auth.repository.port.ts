import type { AppRole, AuthUser, AuthUserRecord } from '../../domain/auth-user.entity.js';

export interface RegisterUserInput {
  readonly authSubject: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: AppRole;
  readonly displayName: string | null;
}

export interface AuthRepository {
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  findById(id: string): Promise<AuthUser | null>;
  registerUser(input: RegisterUserInput): Promise<AuthUser>;
}

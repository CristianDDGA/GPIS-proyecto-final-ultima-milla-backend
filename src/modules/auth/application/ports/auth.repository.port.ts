import type { AppRole, AuthUser, AuthUserRecord } from '../../domain/auth-user.entity.js';

/**
 * pending: el correo debe verificarse con un código (registro propio de un cliente).
 * admin | demo: cuenta de confianza que nace verificada (la crea un administrador o el modo demo).
 */
export type RegistrationVerification = 'pending' | 'admin' | 'demo';

export interface RegisterUserInput {
  readonly authSubject: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: AppRole;
  readonly displayName: string | null;
  readonly verification: RegistrationVerification;
}

export type CodePurpose = 'verify_email' | 'reset_password';
export type CodeCheckResult = 'OK' | 'INVALID' | 'EXPIRED' | 'LOCKED';
export type CodeIssueResult = 'OK' | 'COOLDOWN';

export interface AuthRepository {
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  findById(id: string): Promise<AuthUser | null>;
  /** Como findById, pero incluye el hash de la clave (solo para verificar la clave actual). */
  findRecordById(id: string): Promise<AuthUserRecord | null>;
  registerUser(input: RegisterUserInput): Promise<AuthUser>;
  /** Guarda el hash del código; 'COOLDOWN' si se emitió otro hace menos de 60 s. */
  issueEmailCode(userId: string, purpose: CodePurpose, codeHash: string, ttlSeconds: number): Promise<CodeIssueResult>;
  /** Consume el código de verificación y, si es correcto, marca el correo como verificado. */
  confirmEmail(userId: string, codeHash: string): Promise<CodeCheckResult>;
  /** Consume el código de recuperación y, si es correcto, cambia la clave y cierra las sesiones anteriores. */
  resetPasswordWithCode(userId: string, codeHash: string, newPasswordHash: string): Promise<CodeCheckResult>;
  /** Cambia la clave y cierra las sesiones anteriores. false si el usuario no existe o está inactivo. */
  setPassword(userId: string, newPasswordHash: string): Promise<boolean>;
}

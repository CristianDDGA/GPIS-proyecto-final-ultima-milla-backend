import type { ErrorRequestHandler, Router } from 'express';
import { createAuthUseCases, type AuthUseCases } from './application/auth.use-cases.js';
import type { AuthRepository } from './application/ports/auth.repository.port.js';
import type { EmailSender } from './application/ports/email-sender.port.js';
import type { TokenRevocationStore } from './application/ports/token-revocation.port.js';
import type { TokenService } from './application/ports/token-service.port.js';
import { HmacJwtTokenService } from './infrastructure/crypto/hmac-jwt.token-service.js';
import { InMemoryTokenRevocationStore } from './infrastructure/crypto/in-memory-token-revocation.store.js';
import { deriveCodeKey } from './infrastructure/crypto/one-time-code.js';
import { ScryptPasswordHasher } from './infrastructure/crypto/scrypt-password-hasher.js';
import { ConsoleEmailSender } from './infrastructure/email/console-email-sender.js';
import { authErrorHandler, createAuthRouter } from './presentation/http/auth.router.js';

export interface AuthModuleDependencies {
  readonly repository: AuthRepository;
  readonly jwtSecret: string;
  readonly jwtExpiresInSeconds?: number;
  readonly revocationStore?: TokenRevocationStore;
  /** Sin valor: los correos se escriben en la consola (solo desarrollo). */
  readonly emailSender?: EmailSender;
  /** Por defecto true. false = modo demo: los clientes nacen verificados y no se envía correo. */
  readonly emailVerificationRequired?: boolean;
  readonly codeTtlSeconds?: number;
}

export interface AuthModule {
  readonly router: Router;
  readonly errorHandler: ErrorRequestHandler;
  readonly tokenService: TokenService;
  readonly revocationStore: TokenRevocationStore;
  readonly useCases: AuthUseCases;
}

export function createAuthModule(dependencies: AuthModuleDependencies): AuthModule {
  const hasher = new ScryptPasswordHasher();
  const tokenService = new HmacJwtTokenService(
    dependencies.jwtSecret,
    dependencies.jwtExpiresInSeconds ?? 86_400,
  );
  const revocationStore = dependencies.revocationStore ?? new InMemoryTokenRevocationStore();
  const useCases = createAuthUseCases(
    dependencies.repository,
    hasher,
    tokenService,
    revocationStore,
    {
      emailSender: dependencies.emailSender ?? new ConsoleEmailSender(),
      codeKey: deriveCodeKey(dependencies.jwtSecret),
      emailVerificationRequired: dependencies.emailVerificationRequired ?? true,
      ...(dependencies.codeTtlSeconds !== undefined ? { codeTtlSeconds: dependencies.codeTtlSeconds } : {}),
    },
  );
  return {
    router: createAuthRouter(useCases, tokenService, revocationStore),
    errorHandler: authErrorHandler,
    tokenService,
    revocationStore,
    useCases,
  };
}

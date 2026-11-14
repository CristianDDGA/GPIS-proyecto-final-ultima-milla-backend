import type { ErrorRequestHandler, Router } from 'express';
import { createAuthUseCases, type AuthUseCases } from './application/auth.use-cases.js';
import type { AuthRepository } from './application/ports/auth.repository.port.js';
import type { TokenService } from './application/ports/token-service.port.js';
import { HmacJwtTokenService } from './infrastructure/crypto/hmac-jwt.token-service.js';
import { ScryptPasswordHasher } from './infrastructure/crypto/scrypt-password-hasher.js';
import { authErrorHandler, createAuthRouter } from './presentation/http/auth.router.js';

export interface AuthModuleDependencies {
  readonly repository: AuthRepository;
  readonly jwtSecret: string;
  readonly jwtExpiresInSeconds?: number;
}

export interface AuthModule {
  readonly router: Router;
  readonly errorHandler: ErrorRequestHandler;
  readonly tokenService: TokenService;
  readonly useCases: AuthUseCases;
}

export function createAuthModule(dependencies: AuthModuleDependencies): AuthModule {
  const hasher = new ScryptPasswordHasher();
  const tokenService = new HmacJwtTokenService(
    dependencies.jwtSecret,
    dependencies.jwtExpiresInSeconds ?? 86_400,
  );
  const useCases = createAuthUseCases(dependencies.repository, hasher, tokenService);
  return {
    router: createAuthRouter(useCases, tokenService),
    errorHandler: authErrorHandler,
    tokenService,
    useCases,
  };
}

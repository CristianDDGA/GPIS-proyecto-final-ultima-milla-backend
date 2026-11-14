import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import type { AuthUseCases } from '../../application/auth.use-cases.js';
import type { TokenPayload, TokenService } from '../../application/ports/token-service.port.js';
import { AuthError, type AuthErrorCode } from '../../domain/auth.errors.js';

const STATUS_BY_CODE: Record<AuthErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_CREDENTIALS: 401,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  USER_INACTIVE: 403,
  EMAIL_ALREADY_EXISTS: 409,
  PERSISTENCE_UNAVAILABLE: 503,
};

function bodyObject(request: Request): Record<string, unknown> {
  const value: unknown = request.body;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthError('VALIDATION_ERROR', 'El cuerpo debe ser un objeto JSON.');
  }
  return value as Record<string, unknown>;
}

function extractBearerToken(request: Request, tokens: TokenService): TokenPayload {
  const header = request.get('authorization');
  if (!header) {
    throw new AuthError('UNAUTHORIZED');
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) {
    throw new AuthError('UNAUTHORIZED', 'Cabecera Authorization Bearer inválida.');
  }
  return tokens.verify(match[1]);
}

export function sendAuthError(error: unknown, response: Response): void {
  const failure = error instanceof AuthError ? error : new AuthError('PERSISTENCE_UNAVAILABLE');
  const status = STATUS_BY_CODE[failure.code];
  response.status(status).json({
    code: failure.code,
    message: failure.message,
    error: { code: failure.code, message: failure.message },
  });
}

export const authErrorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (response.headersSent || !/^\/auth(?:\/|$)/.test(request.path)) {
    next(error);
    return;
  }
  const parserType = (error as { type?: string } | null)?.type;
  if (parserType === 'entity.too.large') {
    const code = 'VALIDATION_ERROR';
    const message = 'El cuerpo JSON supera el límite de 32 KB.';
    response.status(413).json({ code, message, error: { code, message } });
    return;
  }
  if (parserType === 'entity.parse.failed') {
    sendAuthError(new AuthError('VALIDATION_ERROR', 'El cuerpo debe contener JSON válido.'), response);
    return;
  }
  sendAuthError(error, response);
};

export function createAuthRouter(useCases: AuthUseCases, tokens: TokenService): Router {
  const router = Router();

  function route(operation: (request: Request, response: Response) => Promise<void>) {
    return (request: Request, response: Response) => {
      void operation(request, response).catch((error: unknown) => sendAuthError(error, response));
    };
  }

  router.post(
    '/register',
    route(async (request, response) => {
      const input = bodyObject(request);
      const session = await useCases.registerCustomer({
        email: input['email'],
        password: input['password'],
        displayName: input['displayName'],
      });
      response.status(201).json(session);
    }),
  );

  router.post(
    '/login',
    route(async (request, response) => {
      const input = bodyObject(request);
      const session = await useCases.login({
        email: input['email'],
        password: input['password'],
      });
      response.status(200).json(session);
    }),
  );

  router.post(
    '/users',
    route(async (request, response) => {
      const claims = extractBearerToken(request, tokens);
      const input = bodyObject(request);
      const user = await useCases.registerByAdmin(
        { role: claims.role },
        {
          email: input['email'],
          password: input['password'],
          role: input['role'],
          displayName: input['displayName'],
        },
      );
      response.status(201).json({ user });
    }),
  );

  router.get(
    '/me',
    route(async (request, response) => {
      const claims = extractBearerToken(request, tokens);
      const user = await useCases.getMe(claims.sub);
      response.status(200).json({ user });
    }),
  );

  return router;
}

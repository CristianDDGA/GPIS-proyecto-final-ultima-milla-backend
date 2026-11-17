import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { getRequestActor } from '../../../../bootstrap/auth.middleware.js';
import type { ApplicationActor, ApplicationUseCases, FileContent } from '../../application/application.use-cases.js';
import { MAX_IMAGE_BYTES } from '../../domain/application.js';
import { ApplicationError, type ApplicationErrorCode } from '../../domain/application.errors.js';

const STATUS_BY_CODE: Record<ApplicationErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  EMAIL_NOT_VERIFIED: 403,
  APPLICATION_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  NO_OPEN_APPLICATION: 409,
  ALREADY_PENDING: 409,
  MISSING_FILES: 409,
  NOT_PENDING: 409,
  DUPLICATE_NATIONAL_ID: 409,
  APPLICANT_NOT_CLIENT: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PERSISTENCE_UNAVAILABLE: 503,
};

function sendApplicationError(error: unknown, response: Response): void {
  const failure = error instanceof ApplicationError ? error : new ApplicationError('PERSISTENCE_UNAVAILABLE');
  response.status(STATUS_BY_CODE[failure.code]).json({
    code: failure.code,
    message: failure.message,
    error: { code: failure.code, message: failure.message },
  });
}

function currentActor(): ApplicationActor {
  const actor = getRequestActor();
  if (!actor) throw new ApplicationError('UNAUTHORIZED');
  return { id: actor.sub, role: actor.role };
}

function bodyObject(request: Request): Record<string, unknown> {
  const value: unknown = request.body;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new ApplicationError('VALIDATION_ERROR', 'El cuerpo debe ser un objeto JSON.');
  }
  return value as Record<string, unknown>;
}

// Acepta el cuerpo binario solo con Content-Type de imagen; cualquier otro tipo deja el cuerpo sin interpretar.
const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: MAX_IMAGE_BYTES });

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch((error: unknown) => {
      if (error instanceof ApplicationError) {
        sendApplicationError(error, response);
        return;
      }
      next(error);
    });
  };
}

function sendFile(response: Response, file: FileContent): void {
  response.status(200);
  response.setHeader('Content-Type', file.contentType);
  response.setHeader('Content-Length', String(file.bytes.length));
  response.setHeader('Content-Disposition', 'inline');
  // Un archivo subido nunca debe poder ejecutar nada si el navegador lo abre directamente.
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  response.end(Buffer.from(file.bytes));
}

export function createApplicationRouter(useCases: ApplicationUseCases): Router {
  const router = Router();
  const param = (request: Request, name: string): unknown => request.params[name];

  // --- Cliente: su propia solicitud (el RBAC global ya exige rol cliente en /me) ---
  router.get(
    '/me',
    route(async (_request, response) => {
      response.status(200).json({ application: await useCases.getMine(currentActor()) });
    }),
  );

  router.put(
    '/me',
    route(async (request, response) => {
      const application = await useCases.saveDraft(currentActor(), bodyObject(request));
      response.status(200).json({ application });
    }),
  );

  router.put(
    '/me/files/:kind',
    rawImage,
    route(async (request, response) => {
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body)) throw new ApplicationError('UNSUPPORTED_MEDIA_TYPE');
      const application = await useCases.uploadFile(currentActor(), param(request, 'kind'), body);
      response.status(200).json({ application });
    }),
  );

  router.get(
    '/me/files/:kind',
    route(async (request, response) => {
      sendFile(response, await useCases.readMyFile(currentActor(), param(request, 'kind')));
    }),
  );

  router.post(
    '/me/submit',
    route(async (_request, response) => {
      response.status(200).json({ application: await useCases.submit(currentActor()) });
    }),
  );

  router.post(
    '/me/cancel',
    route(async (_request, response) => {
      response.status(200).json({ application: await useCases.cancel(currentActor()) });
    }),
  );

  // --- Administrador: revisión ---
  router.get(
    '/',
    route(async (request, response) => {
      const { status, q, limit, offset } = request.query;
      response.status(200).json(await useCases.list(currentActor(), { status, q, limit, offset }));
    }),
  );

  router.get(
    '/:id',
    route(async (request, response) => {
      response.status(200).json({ application: await useCases.get(currentActor(), param(request, 'id')) });
    }),
  );

  router.get(
    '/:id/files/:kind',
    route(async (request, response) => {
      sendFile(response, await useCases.readFile(currentActor(), param(request, 'id'), param(request, 'kind')));
    }),
  );

  router.post(
    '/:id/approve',
    route(async (request, response) => {
      const input = request.body === undefined ? {} : bodyObject(request);
      response.status(200).json({ application: await useCases.approve(currentActor(), param(request, 'id'), input) });
    }),
  );

  router.post(
    '/:id/reject',
    route(async (request, response) => {
      response.status(200).json({ application: await useCases.reject(currentActor(), param(request, 'id'), bodyObject(request)) });
    }),
  );

  return router;
}

export const applicationErrorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (response.headersSent || !/^\/courier-applications(?:[/?]|$)/.test(request.originalUrl)) {
    next(error);
    return;
  }
  const parserType = (error as { type?: string } | null)?.type;
  if (parserType === 'entity.too.large' && /\/files\//.test(request.originalUrl)) {
    sendApplicationError(new ApplicationError('FILE_TOO_LARGE'), response);
    return;
  }
  if (error instanceof ApplicationError) {
    sendApplicationError(error, response);
    return;
  }
  next(error);
};

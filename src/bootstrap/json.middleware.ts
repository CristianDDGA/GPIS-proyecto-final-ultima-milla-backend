import type { ErrorRequestHandler, RequestHandler, Response } from 'express';

function sendError(response: Response, status: number, code: string, message: string): void {
  response.status(status).json({ code, message, error: { code, message } });
}

export const requireJsonObject: RequestHandler = (request, response, next) => {
  if (request.method === 'POST' && /^\/(?:orders|zones)\/?$/i.test(request.path)) {
    const body: unknown = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendError(response, 400, 'VALIDATION_ERROR', 'El cuerpo debe ser un objeto JSON.');
      return;
    }
  }
  next();
};

// Body-parser failures on any path answer with the shared envelope instead of Express HTML.
export const jsonErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const parserError = error as { type?: string } | null;
  if (parserError?.type === 'entity.too.large') {
    sendError(response, 413, 'VALIDATION_ERROR', 'El cuerpo JSON supera el límite de 32 KB.');
    return;
  }
  if (parserError?.type === 'entity.parse.failed') {
    sendError(response, 400, 'VALIDATION_ERROR', 'El cuerpo debe contener JSON válido.');
    return;
  }
  next(error);
};

export const notFoundHandler: RequestHandler = (_request, response) => {
  sendError(response, 404, 'NOT_FOUND', 'Recurso no encontrado.');
};

// Last resort: never leak stack traces, SQL or driver messages.
export const fallbackErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  sendError(response, 500, 'INTERNAL_SERVER_ERROR', 'Error interno inesperado.');
};

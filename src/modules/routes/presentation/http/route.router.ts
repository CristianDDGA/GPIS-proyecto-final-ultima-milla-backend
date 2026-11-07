import { Router, type ErrorRequestHandler } from 'express';
import { sendRouteError, type RouteController } from './route.controller.js';

export const ROUTE_PLANS_PATH = '/route-plans';
export const ROUTES_PATH = '/routes';

export function createRoutePlanRouter(controller: RouteController): Router {
  const router = Router();
  router.post('/', (request, response) => {
    void controller.plan(request, response);
  });
  return router;
}

export function createRouteRouter(controller: RouteController): Router {
  const router = Router();
  router.get('/', (request, response) => {
    void controller.list(request, response);
  });
  router.get('/:id', (request, response) => {
    void controller.getById(request, response);
  });
  return router;
}

// The shared JSON handler only covers Sprint 01 paths; this keeps the same envelope for Routes.
export const routesJsonErrorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  const ownPath = request.path === ROUTE_PLANS_PATH || request.path.startsWith(`${ROUTE_PLANS_PATH}/`) ||
    request.path === ROUTES_PATH || request.path.startsWith(`${ROUTES_PATH}/`);
  if (response.headersSent || !ownPath) {
    next(error);
    return;
  }
  const parserError = error as { type?: string } | null;
  if (parserError?.type === 'entity.too.large') {
    sendRouteError(response, 413, 'VALIDATION_ERROR', 'El cuerpo JSON supera el límite de 32 KB.');
    return;
  }
  if (parserError?.type === 'entity.parse.failed') {
    sendRouteError(response, 400, 'VALIDATION_ERROR', 'El cuerpo debe contener JSON válido.');
    return;
  }
  sendRouteError(response, 500, 'INTERNAL_SERVER_ERROR', 'Error interno inesperado.');
};

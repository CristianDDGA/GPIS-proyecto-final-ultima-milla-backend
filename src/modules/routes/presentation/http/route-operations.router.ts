import { Router, type ErrorRequestHandler } from 'express';
import type { RouteOperationsController } from './route-operations.controller.js';
import { sendRouteError } from './route.controller.js';

export const ROUTE_MOVES_PATH = '/route-moves';
export const LATE_ORDER_PLACEMENTS_PATH = '/late-order-placements';
// PUT /routes/{id}/stop-order lives under the Sprint 02 /routes base; that router only answers GET.
export const ROUTE_STOP_ORDER_BASE_PATH = '/routes';

export function createRouteMoveRouter(controller: RouteOperationsController): Router {
  const router = Router();
  router.post('/', (request, response) => {
    void controller.move(request, response);
  });
  return router;
}

export function createStopOrderRouter(controller: RouteOperationsController): Router {
  const router = Router();
  router.put('/:id/stop-order', (request, response) => {
    void controller.reorder(request, response);
  });
  return router;
}

export function createLatePlacementRouter(controller: RouteOperationsController): Router {
  const router = Router();
  router.post('/', (request, response) => {
    void controller.placeLate(request, response);
  });
  return router;
}

function ownPath(path: string): boolean {
  return [ROUTE_MOVES_PATH, LATE_ORDER_PLACEMENTS_PATH].some((base) => path === base || path.startsWith(`${base}/`));
}

// Same envelope as Routes S2 for the new top-level paths; /routes/* stays with the S2 handler.
export const routeOperationsJsonErrorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (response.headersSent || !ownPath(request.path)) {
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

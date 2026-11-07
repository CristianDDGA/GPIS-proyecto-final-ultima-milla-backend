import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import type { CourierUseCases } from '../../application/courier.use-cases.js';
import type { AssignmentUseCases } from '../../application/assignment.use-cases.js';
import { CourierError } from '../../domain/courier.errors.js';
function body(request: Request): Record<string, unknown> {
  const value: unknown = request.body;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CourierError('VALIDATION_ERROR');
  return value as Record<string, unknown>;
}
function sendError(error: unknown, response: Response): void {
  const failure = error instanceof CourierError ? error : new CourierError('PERSISTENCE_UNAVAILABLE');
  const status = { VALIDATION_ERROR: 400, COURIER_NOT_FOUND: 404, ROUTE_NOT_FOUND: 404, DATA_CONFLICT: 409, PERSISTENCE_UNAVAILABLE: 503 }[failure.code];
  response.status(status).json({ code: failure.code, message: failure.message, error: { code: failure.code, message: failure.message } });
}
export const courierErrorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (response.headersSent || !/^\/(couriers|courier-assignments)(\/|$)/.test(request.path)) { next(error); return; }
  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.too.large') {
    const code = 'VALIDATION_ERROR'; const message = 'El cuerpo JSON supera el límite de 32 KB.';
    response.status(413).json({ code, message, error: { code, message } }); return;
  }
  sendError(type === 'entity.parse.failed' ? new CourierError('VALIDATION_ERROR') : error, response);
};
export function createCourierRouter(couriers: CourierUseCases, assignments: AssignmentUseCases): Router {
  const router = Router();
  function route(operation: (request: Request, response: Response) => Promise<void>) {
    return (request: Request, response: Response) => { void operation(request, response).catch(error => sendError(error, response)); };
  }
  router.post('/couriers', route(async (request, response) => {
    const input = body(request);
    response.status(201).json(await couriers.create(input['displayName'], input['maxOrdersPerTrip']));
  }));
  router.get('/couriers', route(async (request, response) => { response.json(await couriers.list(request.query)); }));
  router.patch('/couriers/:id/availability', route(async (request, response) => {
    response.json(await couriers.setAvailability(request.params['id'], body(request)['isAvailable']));
  }));
  router.post('/courier-assignments', route(async (request, response) => {
    const input = body(request);
    response.json(await assignments.assign(input['routeId'], input['courierId']));
  }));
  router.get('/couriers/:id/route', route(async (request, response) => { response.json(await assignments.getRoute(request.params['id'])); }));
  return router;
}

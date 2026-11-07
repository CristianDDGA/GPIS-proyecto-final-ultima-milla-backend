import type { Request, Response } from 'express';
import type { PlanRoutesUseCase } from '../../application/use-cases/plan-routes.use-case.js';
import type { ListRoutesUseCase } from '../../application/use-cases/list-routes.use-case.js';
import type { GetRouteUseCase } from '../../application/use-cases/get-route.use-case.js';
import {
  RouteConflictError,
  RouteNotFoundError,
  RoutePersistenceUnavailableError,
  RouteValidationError,
} from '../../domain/route.errors.js';

export function sendRouteError(response: Response, status: number, code: string, message: string): void {
  // Same envelope as Sprint 01: top-level fields plus nested error with identical values.
  response.status(status).json({ code, message, error: { code, message } });
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteValidationError('El cuerpo debe ser un objeto JSON con serviceDate y capacityLimit.');
  }
  return value as Record<string, unknown>;
}

// Query values must be single texts: repeated or nested parameters are rejected.
function optionalQueryText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RouteValidationError(`El parámetro ${field} debe enviarse una sola vez y no puede estar vacío.`);
  }
  return value;
}

export class RouteController {
  constructor(
    private readonly planRoutesUseCase: PlanRoutesUseCase,
    private readonly listRoutesUseCase: ListRoutesUseCase,
    private readonly getRouteUseCase: GetRouteUseCase
  ) {}

  async plan(request: Request, response: Response): Promise<void> {
    try {
      const body = bodyObject(request.body);
      const result = await this.planRoutesUseCase.execute({
        serviceDate: body['serviceDate'],
        capacityLimit: body['capacityLimit'],
        idempotencyKey: request.get('Idempotency-Key'),
      });
      response.status(200).json({ serviceDate: result.serviceDate, routeIds: result.routeIds });
    } catch (error: unknown) {
      this.handleError(error, response);
    }
  }

  async list(request: Request, response: Response): Promise<void> {
    try {
      const serviceDate = optionalQueryText(request.query['serviceDate'], 'serviceDate');
      const zoneId = optionalQueryText(request.query['zoneId'], 'zoneId');
      const limit = optionalQueryText(request.query['limit'], 'limit');
      const offset = optionalQueryText(request.query['offset'], 'offset');
      const page = await this.listRoutesUseCase.execute({
        ...(serviceDate !== undefined ? { serviceDate } : {}),
        ...(zoneId !== undefined ? { zoneId } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      response.status(200).json({ items: page.items, limit: page.limit, offset: page.offset });
    } catch (error: unknown) {
      this.handleError(error, response);
    }
  }

  async getById(request: Request, response: Response): Promise<void> {
    try {
      response.status(200).json(await this.getRouteUseCase.execute(request.params['id']));
    } catch (error: unknown) {
      this.handleError(error, response);
    }
  }

  private handleError(error: unknown, response: Response): void {
    if (error instanceof RouteValidationError) return sendRouteError(response, 400, error.code, error.message);
    if (error instanceof RouteNotFoundError) return sendRouteError(response, 404, error.code, error.message);
    if (error instanceof RouteConflictError) return sendRouteError(response, 409, error.code, error.message);
    if (error instanceof RoutePersistenceUnavailableError) return sendRouteError(response, 503, error.code, error.message);
    // Integrity faults and unexpected errors expose no internal detail.
    sendRouteError(response, 500, 'INTERNAL_SERVER_ERROR', 'Error interno inesperado.');
  }
}

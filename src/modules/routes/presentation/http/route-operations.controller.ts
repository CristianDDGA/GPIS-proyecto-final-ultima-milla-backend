import type { Request, Response } from 'express';
import type { MoveOrderUseCase } from '../../application/use-cases/move-order.use-case.js';
import type { ReorderStopsUseCase } from '../../application/use-cases/reorder-stops.use-case.js';
import type { PlaceLateOrderUseCase } from '../../application/use-cases/place-late-order.use-case.js';
import {
  RouteConflictError,
  RouteNotFoundError,
  RouteOrderNotFoundError,
  RoutePersistenceUnavailableError,
  RouteValidationError,
} from '../../domain/route.errors.js';
import { sendRouteError } from './route.controller.js';

function bodyObject(value: unknown, fields: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteValidationError(`El cuerpo debe ser un objeto JSON con ${fields}.`);
  }
  return value as Record<string, unknown>;
}

// Extra body fields are ignored, as in Sprint 02. Every answer comes from the persisted transaction.
export class RouteOperationsController {
  constructor(
    private readonly moveOrderUseCase: MoveOrderUseCase,
    private readonly reorderStopsUseCase: ReorderStopsUseCase,
    private readonly placeLateOrderUseCase: PlaceLateOrderUseCase
  ) {}

  async move(request: Request, response: Response): Promise<void> {
    try {
      const body = bodyObject(request.body, 'orderId y destinationRouteId');
      const result = await this.moveOrderUseCase.execute({
        orderId: body['orderId'],
        destinationRouteId: body['destinationRouteId'],
      });
      response.status(200).json({ orderId: result.orderId, routeId: result.routeId });
    } catch (error: unknown) {
      handleError(error, response);
    }
  }

  async reorder(request: Request, response: Response): Promise<void> {
    try {
      const body = bodyObject(request.body, 'orderIds');
      const result = await this.reorderStopsUseCase.execute({ routeId: request.params['id'], orderIds: body['orderIds'] });
      response.status(200).json({ routeId: result.routeId, orderIds: result.orderIds });
    } catch (error: unknown) {
      handleError(error, response);
    }
  }

  async placeLate(request: Request, response: Response): Promise<void> {
    try {
      const body = bodyObject(request.body, 'orderId y capacityLimit');
      const result = await this.placeLateOrderUseCase.execute({
        orderId: body['orderId'],
        capacityLimit: body['capacityLimit'],
        idempotencyKey: request.get('Idempotency-Key'),
      });
      response.status(200).json(
        result.status === 'asignado_a_ruta'
          ? { orderId: result.orderId, status: result.status, routeId: result.routeId }
          : { orderId: result.orderId, status: result.status, reason: result.reason }
      );
    } catch (error: unknown) {
      handleError(error, response);
    }
  }
}

function handleError(error: unknown, response: Response): void {
  if (error instanceof RouteValidationError) return sendRouteError(response, 400, error.code, error.message);
  if (error instanceof RouteOrderNotFoundError) return sendRouteError(response, 404, error.code, error.message);
  if (error instanceof RouteNotFoundError) return sendRouteError(response, 404, error.code, error.message);
  if (error instanceof RouteConflictError) return sendRouteError(response, 409, error.code, error.message);
  if (error instanceof RoutePersistenceUnavailableError) return sendRouteError(response, 503, error.code, error.message);
  // Integrity faults and unexpected errors expose no internal detail.
  sendRouteError(response, 500, 'INTERNAL_SERVER_ERROR', 'Error interno inesperado.');
}

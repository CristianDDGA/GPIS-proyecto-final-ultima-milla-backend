import type { Request, Response } from 'express';
import type { ChangeDeliveryStatusUseCase } from '../../application/use-cases/change-delivery-status.use-case.js';
import type { CompleteRouteUseCase } from '../../application/use-cases/complete-route.use-case.js';
import type { GetDeliveryOrderUseCase } from '../../application/use-cases/get-delivery-order.use-case.js';
import { DeliveryError, type DeliveryErrorCode } from '../../domain/delivery.errors.js';

const ERROR_HTTP_STATUS: Readonly<Record<DeliveryErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  FORBIDDEN: 403,
  ORDER_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  DATA_CONFLICT: 409,
  PERSISTENCE_UNAVAILABLE: 503,
};

function parseJsonObjectBody(request: Request): Record<string, unknown> {
  const value: unknown = request.body;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeliveryError('VALIDATION_ERROR', 'El cuerpo debe ser un objeto JSON.');
  }
  return value as Record<string, unknown>;
}

function readIdempotencyKeyHeader(request: Request): unknown {
  const raw = request.headers['idempotency-key'];
  if (Array.isArray(raw)) {
    return undefined;
  }
  return raw;
}

export function sendDeliveryError(error: unknown, response: Response): void {
  const failure =
    error instanceof DeliveryError
      ? error
      : new DeliveryError('PERSISTENCE_UNAVAILABLE');
  const status = ERROR_HTTP_STATUS[failure.code];
  response.status(status).json({
    code: failure.code,
    message: failure.message,
    error: { code: failure.code, message: failure.message },
  });
}

export class DeliveryController {
  constructor(
    private readonly getOrderUseCase: GetDeliveryOrderUseCase,
    private readonly changeStatusUseCase: ChangeDeliveryStatusUseCase,
    private readonly completeRouteUseCase: CompleteRouteUseCase,
  ) {}

  async getOrder(request: Request, response: Response): Promise<void> {
    const order = await this.getOrderUseCase.execute(request.params['id']);
    response.status(200).json(order);
  }

  async changeStatus(request: Request, response: Response): Promise<void> {
    const body = parseJsonObjectBody(request);
    // Actor identity always comes from server-injected ActorContextPort, never from request body.
    const result = await this.changeStatusUseCase.execute({
      orderId: body['orderId'],
      newStatus: body['newStatus'],
      expectedVersion: body['expectedVersion'],
      idempotencyKey: readIdempotencyKeyHeader(request),
    });
    response.status(200).json(result);
  }

  async completeRoute(request: Request, response: Response): Promise<void> {
    const body = parseJsonObjectBody(request);
    const result = await this.completeRouteUseCase.execute(body['routeId']);
    response.status(200).json(result);
  }
}

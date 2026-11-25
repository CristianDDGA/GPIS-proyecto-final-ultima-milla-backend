import type { Request, Response } from 'express';
import type { CreateOrderUseCase } from '../../application/use-cases/create-order.use-case.js';
import type { GetOrderUseCase } from '../../application/use-cases/get-order.use-case.js';
import type { ListOrdersUseCase } from '../../application/use-cases/list-orders.use-case.js';
import {
  OrderConflictError,
  OrderNotFoundError,
  OrderOutOfCoverageError,
  OrderPersistenceUnavailableError,
  OrderValidationError,
  ZoneNotFoundError,
} from '../../domain/order.errors.js';

function bodyFields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrderValidationError('El cuerpo debe ser un objeto JSON con los datos del pedido.');
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new OrderValidationError(`El campo ${field} es obligatorio y debe ser un texto.`);
  }
  return value;
}

/** Número opcional (el pin): ausente o null es "sin pin"; cualquier otro tipo es un error del cuerpo. */
function optionalNumberField(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') {
    throw new OrderValidationError(`El campo ${field} debe ser un número.`);
  }
  return value;
}

export class OrderController {
  constructor(
    private readonly createOrderUseCase: CreateOrderUseCase,
    private readonly getOrderUseCase: GetOrderUseCase,
    private readonly listOrdersUseCase: ListOrdersUseCase
  ) {}

  async create(request: Request, response: Response): Promise<void> {
    try {
      const body = bodyFields(request.body);
      const order = await this.createOrderUseCase.execute({
        zoneId: stringField(body['zoneId'], 'zoneId'),
        deliveryAddress: stringField(body['deliveryAddress'], 'deliveryAddress'),
        deliveryDate: stringField(body['deliveryDate'], 'deliveryDate'),
        deliveryTime: stringField(body['deliveryTime'], 'deliveryTime'),
        latitude: optionalNumberField(body['latitude'], 'latitude'),
        longitude: optionalNumberField(body['longitude'], 'longitude'),
      });
      response.status(201).json(order.toJSON());
    } catch (error: unknown) {
      this.handleError(error, response);
    }
  }

  async getById(request: Request, response: Response): Promise<void> {
    try {
      const id = stringField(request.params['id'], 'id');
      const order = await this.getOrderUseCase.execute(id);
      response.status(200).json(order.toJSON());
    } catch (error: unknown) {
      this.handleError(error, response);
    }
  }

  async list(request: Request, response: Response): Promise<void> {
    try {
      const rawDeliveryDate = request.query['deliveryDate'];
      const rawZoneId = request.query['zoneId'];
      const orders = await this.listOrdersUseCase.execute({
        ...(rawDeliveryDate !== undefined ? { deliveryDate: stringField(rawDeliveryDate, 'deliveryDate') } : {}),
        ...(rawZoneId !== undefined ? { zoneId: stringField(rawZoneId, 'zoneId') } : {}),
      });
      response.status(200).json({ items: orders.map((order) => order.toJSON()) });
    } catch (error: unknown) {
      this.handleError(error, response);
    }
  }

  private handleError(error: unknown, response: Response): void {
    let status = 500;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'Error interno inesperado.';
    if (error instanceof OrderValidationError) {
      status = 400;
    } else if (error instanceof OrderNotFoundError || error instanceof ZoneNotFoundError) {
      status = 404;
    } else if (error instanceof OrderConflictError) {
      status = 409;
    } else if (error instanceof OrderOutOfCoverageError) {
      status = 422;
    } else if (error instanceof OrderPersistenceUnavailableError) {
      status = 503;
    }
    if (status !== 500 && error instanceof Error && 'code' in error && typeof error.code === 'string') {
      code = error.code;
      message = error.message;
    }
    // Preserve Jhon's existing top-level fields and nested error during Sprint 01.
    response.status(status).json({ code, message, error: { code, message } });
  }
}

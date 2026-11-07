import { RouteIntegrityError } from './route.errors.js';
import { validateOrderIdList, validateUuid } from './route.validation.js';

export interface RouteMoveCommand {
  readonly orderId: string;
  readonly destinationRouteId: string;
}

export interface RouteMoveResult {
  readonly orderId: string;
  readonly routeId: string;
}

export interface StopOrderCommand {
  readonly routeId: string;
  readonly orderIds: readonly string[];
}

export interface StopOrderResult {
  readonly routeId: string;
  readonly orderIds: readonly string[];
}

function integrity(condition: boolean, message: string): void {
  if (!condition) throw new RouteIntegrityError(message);
}

function persistedUuid(value: unknown, message: string): string {
  integrity(typeof value === 'string', message);
  try {
    return validateUuid(value, 'persisted');
  } catch {
    throw new RouteIntegrityError(message);
  }
}

// Manual adjustments before departure. Business rules (zone/date, capacity, started route) are enforced by the
// original SQL functions; the domain validates input and checks that the persisted answer matches the command.
export const RouteOperations = {
  prepareMove(input: { orderId: unknown; destinationRouteId: unknown }): RouteMoveCommand {
    return {
      orderId: validateUuid(input.orderId, 'orderId'),
      destinationRouteId: validateUuid(input.destinationRouteId, 'destinationRouteId'),
    };
  },

  acceptMove(command: RouteMoveCommand, persisted: { routeId: unknown }): RouteMoveResult {
    const routeId = persistedUuid(persisted.routeId, 'El movimiento no devolvió una ruta vigente válida.');
    integrity(routeId === command.destinationRouteId, 'El pedido no quedó en la ruta destino.');
    return { orderId: command.orderId, routeId };
  },

  prepareStopOrder(input: { routeId: unknown; orderIds: unknown }): StopOrderCommand {
    return {
      routeId: validateUuid(input.routeId, 'id'),
      orderIds: validateOrderIdList(input.orderIds),
    };
  },

  // The same list must produce the same observable order: the confirmed sequence equals the requested one.
  acceptStopOrder(command: StopOrderCommand, persisted: { orderIds: unknown }): StopOrderResult {
    integrity(Array.isArray(persisted.orderIds), 'El reordenamiento no devolvió la lista de paradas.');
    const orderIds = (persisted.orderIds as unknown[]).map((id) =>
      persistedUuid(id, 'El reordenamiento devolvió un pedido inválido.'));
    integrity(
      orderIds.length === command.orderIds.length && orderIds.every((id, index) => id === command.orderIds[index]),
      'El orden confirmado no coincide con el solicitado.'
    );
    return { routeId: command.routeId, orderIds };
  },
};

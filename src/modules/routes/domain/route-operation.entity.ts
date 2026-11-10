import { RouteIntegrityError } from './route.errors.js';
import { validateCapacityLimit, validateOrderIdList, validateUuid } from './route.validation.js';

export const LATE_PLACEMENT_PENDING_REASON = 'NO_AVAILABLE_COURIER' as const;

export interface LatePlacementCommand {
  readonly orderId: string;
  readonly capacityLimit: number;
  readonly idempotencyKey: string;
}

// Waiting without a courier is an explicit business outcome, not a technical error or a delivered order.
export type LatePlacementResult =
  | { readonly orderId: string; readonly status: 'asignado_a_ruta'; readonly routeId: string }
  | { readonly orderId: string; readonly status: 'pendiente'; readonly reason: typeof LATE_PLACEMENT_PENDING_REASON };

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

  prepareLatePlacement(input: { orderId: unknown; capacityLimit: unknown; idempotencyKey: unknown }): LatePlacementCommand {
    return {
      idempotencyKey: validateUuid(input.idempotencyKey, 'Idempotency-Key'),
      orderId: validateUuid(input.orderId, 'orderId'),
      capacityLimit: validateCapacityLimit(input.capacityLimit),
    };
  },

  // The stored answer (first run or replay) must be about the requested order and be one of the two outcomes.
  acceptLatePlacement(command: LatePlacementCommand, persisted: unknown): LatePlacementResult {
    integrity(persisted !== null && typeof persisted === 'object' && !Array.isArray(persisted),
      'La incorporación tardía no devolvió un resultado.');
    const result = persisted as Record<string, unknown>;
    const orderId = persistedUuid(result['orderId'], 'La incorporación tardía devolvió un pedido inválido.');
    integrity(orderId === command.orderId, 'La incorporación tardía respondió por otro pedido.');
    if (result['status'] === 'asignado_a_ruta') {
      const routeId = persistedUuid(result['routeId'], 'La incorporación tardía no devolvió la ruta asignada.');
      return { orderId, status: 'asignado_a_ruta', routeId };
    }
    integrity(result['status'] === 'pendiente' && result['reason'] === LATE_PLACEMENT_PENDING_REASON,
      'La incorporación tardía devolvió un estado desconocido.');
    return { orderId, status: 'pendiente', reason: LATE_PLACEMENT_PENDING_REASON };
  },
};

import type { RouteMoveCommand, StopOrderCommand } from '../../domain/route-operation.entity.js';

// Write port for manual route adjustments. Each method runs one original SQL command and reads its persisted
// effect in the same transaction; missing identities raise RouteOrderNotFoundError / RouteNotFoundError.
export interface RouteOperationsRepository {
  moveOrder(command: RouteMoveCommand): Promise<{ readonly routeId: unknown }>;
  reorderStops(command: StopOrderCommand): Promise<{ readonly orderIds: unknown }>;
}

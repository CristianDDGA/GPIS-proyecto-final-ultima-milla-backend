import type {
  DeliveryOrder,
  DeliveryStatusChangeCommand,
  DeliveryStatusChangeResult,
  RouteCompletionResult,
} from '../../domain/delivery-order.js';

export interface DeliveryRepository {
  findOrderById(orderId: string): Promise<DeliveryOrder | null>;
  changeOrderStatus(
    actorId: string,
    command: DeliveryStatusChangeCommand,
  ): Promise<DeliveryStatusChangeResult>;
  completeRoute(actorId: string, routeId: string): Promise<RouteCompletionResult>;
}

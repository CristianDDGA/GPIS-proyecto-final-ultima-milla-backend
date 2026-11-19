import type {
  Address,
  AddressPatch,
  AdminCashRow,
  AdminOrderFilter,
  CancelReason,
  CancelResult,
  CourierCash,
  CourierOrder,
  DeliveryOutcome,
  FailureReason,
  FlowActor,
  LowStockItem,
  NewAddress,
  NotificationOutcome,
  PendingNotification,
  RescheduleResult,
  SalesSummary,
  SettlementResult,
} from '../../domain/flows.types.js';
import type { Page, StoreOrderDetail } from '../../domain/store.types.js';

/** Flujos por rol: cancelar, entrega fallida y cobro, caja, libreta de direcciones, reportes y cola de avisos. */
export interface FlowsRepository {
  /** Cliente dueño o administrador. Idempotente por estado. Devuelve el stock una sola vez. */
  cancelOrder(input: { orderId: string; actor: FlowActor; reason: CancelReason; note: string | null }): Promise<CancelResult>;
  /** Solo un pedido con entrega fallida y ruta cerrada; máximo 3 intentos de entrega. */
  rescheduleOrder(input: { orderId: string; actor: FlowActor; deliveryDate: string; deliveryTime: string }): Promise<RescheduleResult>;

  courierOrders(courierUserId: string): Promise<readonly CourierOrder[]>;
  /** Pedido de tienda: el monto cobrado debe ser exactamente el total. Idempotente por clave. */
  deliverOrder(input: {
    orderId: string; courierUserId: string; expectedVersion: number; collectedCents: number; idempotencyKey: string;
  }): Promise<DeliveryOutcome>;
  failDelivery(input: {
    orderId: string; courierUserId: string; expectedVersion: number; reason: FailureReason; note: string | null; idempotencyKey: string;
  }): Promise<DeliveryOutcome>;

  courierCash(courierUserId: string, date: string): Promise<CourierCash>;
  adminCash(date: string): Promise<readonly AdminCashRow[]>;
  settleCash(input: { courierUserId: string; date: string; receivedCents: number; note: string | null; actorId: string }): Promise<SettlementResult>;

  listAddresses(userId: string): Promise<readonly Address[]>;
  createAddress(userId: string, input: NewAddress): Promise<Address>;
  updateAddress(userId: string, id: string, patch: AddressPatch, expectedVersion: number): Promise<Address>;
  deleteAddress(userId: string, id: string): Promise<void>;

  listOrderDetails(filter: AdminOrderFilter, paging: { readonly page: number; readonly pageSize: number }): Promise<Page<StoreOrderDetail>>;
  lowStock(threshold: number, limit: number): Promise<readonly LowStockItem[]>;
  summary(from: string, to: string): Promise<SalesSummary>;

  /** Reclama avisos pendientes (varias instancias no se pisan) y los marca como en proceso. */
  claimNotifications(limit: number): Promise<readonly PendingNotification[]>;
  finishNotification(id: string, outcome: NotificationOutcome): Promise<void>;
}

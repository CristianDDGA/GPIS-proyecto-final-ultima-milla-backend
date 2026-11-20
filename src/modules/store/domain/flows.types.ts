// Tipos de los flujos por rol: cancelar, entrega fallida, cobro, caja, direcciones, reportes y avisos por correo.

export const CANCEL_REASONS = ['cliente_desiste', 'error_en_pedido', 'sin_stock', 'no_localizable', 'demora', 'otro'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const FAILURE_REASONS = ['cliente_ausente', 'direccion_incorrecta', 'cliente_rechazo', 'zona_inaccesible', 'otro'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const MAX_DELIVERY_ATTEMPTS = 3;
export const MAX_ADDRESSES = 10;

/** Quién actúa. El cliente solo toca lo suyo; el administrador, todo; el repartidor, sus paradas. */
export interface FlowActor {
  readonly id: string;
  readonly role: 'personal' | 'cliente' | 'repartidor';
}

export interface CancelResult {
  readonly status: 'cancelado';
  readonly alreadyCancelled: boolean;
  readonly restocked: boolean;
  readonly version: number;
}

export type RescheduleResult =
  | { readonly status: 'ok'; readonly orderId: string; readonly orderStatus: 'pendiente'; readonly version: number }
  | { readonly status: 'conflict'; readonly reason: 'slot_invalid' | 'slot_unavailable' | 'slot_full' };

export interface CourierOrderLine {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

/** Una parada de la ruta del conductor, con lo que lleva y cuánto debe cobrar. */
export interface CourierOrder {
  readonly orderId: string;
  readonly version: number;
  readonly status: string;
  readonly routeId: string;
  readonly routeStatus: string;
  readonly position: number;
  readonly deliveryAddress: string;
  readonly deliveryDate: string;
  readonly deliveryTime: string;
  readonly recipientName: string | null;
  readonly recipientPhone: string | null;
  readonly notes: string | null;
  /** Solo los pedidos de tienda traen total y líneas; un pedido normal no tiene cobro. */
  readonly isStoreOrder: boolean;
  readonly totalCents: number | null;
  readonly items: readonly CourierOrderLine[];
  readonly failedAttempts: number;
  /** Destino en el mapa (nulo si la dirección fue manual). */
  readonly deliveryLatitude: number | null;
  readonly deliveryLongitude: number | null;
}

export interface DeliveryOutcome {
  readonly orderId: string;
  readonly status: 'entregado' | 'entrega_fallida';
  readonly version: number;
  readonly collectedCents?: number;
  readonly attempt?: number;
  readonly replayed: boolean;
}

export interface CourierCash {
  readonly date: string;
  readonly collectedCents: number;
  readonly ordersCount: number;
  readonly settlement: { readonly receivedCents: number; readonly differenceCents: number; readonly settledAt: string } | null;
}

export interface AdminCashRow extends CourierCash {
  readonly courierUserId: string;
  readonly courierName: string | null;
}

export interface SettlementResult {
  readonly expectedCents: number;
  readonly receivedCents: number;
  readonly differenceCents: number;
}

export interface Address {
  readonly id: string;
  readonly label: string;
  readonly zoneId: string;
  readonly address: string;
  readonly recipientName: string | null;
  readonly recipientPhone: string | null;
  readonly isDefault: boolean;
  readonly version: number;
  /** Pin del mapa; nulo si la dirección se escribió a mano. */
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface NewAddress {
  readonly label: string;
  readonly zoneId: string;
  readonly address: string;
  readonly recipientName: string | null;
  readonly recipientPhone: string | null;
  readonly isDefault: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface AddressPatch {
  readonly label?: string;
  readonly zoneId?: string;
  readonly address?: string;
  readonly recipientName?: string | null;
  readonly recipientPhone?: string | null;
  readonly isDefault?: boolean;
  /** Las dos juntas: valores para poner o cambiar el pin, o ambas null para quitarlo. */
  readonly latitude?: number | null;
  readonly longitude?: number | null;
}

export interface AdminOrderFilter {
  readonly status?: string;
  readonly deliveryDate?: string;
  readonly zoneId?: string;
}

export interface LowStockItem {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly stockQuantity: number;
  readonly isActive: boolean;
}

export interface SalesSummary {
  readonly from: string;
  readonly to: string;
  readonly orders: { readonly total: number; readonly byStatus: Readonly<Record<string, number>> };
  /** Suma de los pedidos no cancelados (lo vendido), en centavos. */
  readonly grossCents: number;
  /** Suma de lo cobrado en efectivo por los conductores en el rango. */
  readonly collectedCents: number;
  readonly cancellations: { readonly count: number; readonly byReason: Readonly<Record<string, number>> };
  readonly failures: { readonly count: number; readonly byReason: Readonly<Record<string, number>> };
  readonly topProducts: ReadonlyArray<{ readonly productId: string; readonly name: string; readonly units: number; readonly revenueCents: number }>;
  readonly lowStockCount: number;
}

// --- Avisos por correo -------------------------------------------------------------------------------------
export type NotificationKind = 'order_confirmed' | 'order_status' | 'order_cancelled' | 'order_rescheduled';

export interface PendingNotification {
  readonly id: string;
  readonly orderId: string;
  readonly kind: NotificationKind;
  readonly statusTo: string | null;
  readonly attempts: number;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly emailVerifiedVia: string | null;
}

export type NotificationOutcome = 'sent' | 'skipped' | 'retry';

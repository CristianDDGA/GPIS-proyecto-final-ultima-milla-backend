// Tipos del dominio de la tienda. Todo el dinero son enteros en centavos (USD); nunca decimales.

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly version: number;
}

export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly brand: string | null;
  readonly description: string | null;
  readonly category: { readonly id: string; readonly name: string };
  readonly priceCents: number;
  readonly compareAtPriceCents: number | null;
  /** Porcentaje entero de descuento frente al precio de lista, o null si no hay oferta. */
  readonly discountPercent: number | null;
  readonly stockQuantity: number;
  readonly imageKey: string | null;
  readonly isActive: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export type ProductSort = 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'discount';
export const PRODUCT_SORTS: readonly ProductSort[] = ['relevance', 'price_asc', 'price_desc', 'newest', 'discount'];

export type ProductStatusFilter = 'active' | 'inactive' | 'all';

export interface ProductFilter {
  readonly q?: string;
  readonly categoryId?: string;
  readonly minPriceCents?: number;
  readonly maxPriceCents?: number;
  readonly onSale: boolean;
  readonly status: ProductStatusFilter;
  readonly sort: ProductSort;
  readonly page: number;
  readonly pageSize: number;
}

export interface NewProduct {
  readonly sku: string;
  readonly name: string;
  readonly brand: string | null;
  readonly description: string | null;
  readonly categoryId: string;
  readonly priceCents: number;
  readonly compareAtPriceCents: number | null;
  readonly stock: number;
  readonly imageKey: string | null;
  readonly isActive: boolean;
}

/** Solo los campos presentes se cambian; null borra marca, descripción, imagen u oferta. */
export interface ProductPatch {
  readonly name?: string;
  readonly brand?: string | null;
  readonly description?: string | null;
  readonly categoryId?: string;
  readonly priceCents?: number;
  readonly compareAtPriceCents?: number | null;
  readonly imageKey?: string | null;
  readonly isActive?: boolean;
}

export const STOCK_REASONS = ['restock', 'correction', 'damage'] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export interface ProductEvent {
  readonly id: string;
  readonly action: string;
  readonly actorUserId: string | null;
  readonly changes: Record<string, unknown>;
  readonly createdAt: string;
}

export interface StoreSettings {
  readonly slotCapacity: number;
  readonly firstSlotHour: number;
  readonly lastSlotHour: number;
  readonly minLeadMinutes: number;
}

export interface DeliverySlot {
  /** Hora de inicio, HH:MM en punto. */
  readonly time: string;
  readonly capacity: number;
  readonly reserved: number;
  readonly available: boolean;
}

export const MAX_ORDER_LINES = 20;
export const MAX_LINE_QUANTITY = 10;

export interface OrderItemInput {
  readonly productId: string;
  readonly quantity: number;
  /** Precio que el cliente vio al agregar al carrito; si cambió, el pedido se rechaza con PRICE_CHANGED. */
  readonly unitPriceCents: number;
}

export interface PlaceOrderCommand {
  readonly customerId: string;
  readonly zoneId: string;
  readonly deliveryAddress: string;
  readonly deliveryDate: string;
  readonly deliveryTime: string;
  readonly recipientName: string | null;
  readonly recipientPhone: string | null;
  readonly notes: string | null;
  readonly items: readonly OrderItemInput[];
  readonly idempotencyKey: string;
}

export type OrderConflictReason =
  | 'unavailable'
  | 'price_changed'
  | 'insufficient_stock'
  | 'slot_invalid'
  | 'slot_unavailable'
  | 'slot_full'
  | 'zone_inactive';

export interface OrderConflict {
  readonly reason: OrderConflictReason;
  readonly productId?: string;
  readonly currentPriceCents?: number;
  readonly available?: number;
  readonly capacity?: number;
}

export type PlaceOrderResult =
  | { readonly status: 'ok'; readonly orderId: string; readonly totalCents: number; readonly itemsCount: number; readonly replayed: boolean }
  | { readonly status: 'conflict'; readonly conflicts: readonly OrderConflict[]; readonly replayed: boolean };

export interface StoreOrderSummary {
  readonly id: string;
  readonly status: string;
  readonly zoneId: string;
  readonly deliveryAddress: string;
  readonly deliveryDate: string;
  readonly deliveryTime: string;
  readonly totalCents: number;
  readonly itemsCount: number;
  readonly paymentMethod: string;
  readonly createdAt: string;
}

export interface StoreOrderLine {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly lineTotalCents: number;
  readonly imageKey: string | null;
}

export interface StoreOrderDetail extends StoreOrderSummary {
  readonly customerId: string;
  readonly recipientName: string | null;
  readonly recipientPhone: string | null;
  readonly notes: string | null;
  readonly items: readonly StoreOrderLine[];
}

/** Quién pregunta: el cliente solo ve sus pedidos; el administrador ve todos. */
export interface OrderScope {
  readonly customerId?: string;
}

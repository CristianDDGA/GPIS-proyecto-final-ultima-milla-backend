import { randomUUID } from 'node:crypto';
import type { FlowsRepository } from '../../application/ports/flows.ports.js';
import type { CatalogRepository, StoreOrderRepository } from '../../application/ports/store.ports.js';
import {
  MAX_ADDRESSES,
  MAX_DELIVERY_ATTEMPTS,
  type Address,
  type AddressPatch,
  type AdminCashRow,
  type AdminOrderFilter,
  type CancelReason,
  type CancelResult,
  type CourierCash,
  type CourierOrder,
  type DeliveryOutcome,
  type FailureReason,
  type FlowActor,
  type LowStockItem,
  type NewAddress,
  type NotificationKind,
  type NotificationOutcome,
  type PendingNotification,
  type RescheduleResult,
  type SalesSummary,
  type SettlementResult,
} from '../../domain/flows.types.js';
import { StoreError } from '../../domain/store.errors.js';
import type {
  Category,
  DeliverySlot,
  NewProduct,
  OrderConflict,
  OrderScope,
  Page,
  PlaceOrderCommand,
  PlaceOrderResult,
  Product,
  ProductEvent,
  ProductFilter,
  ProductPatch,
  StockReason,
  StoreOrderDetail,
  StoreOrderLine,
  StoreOrderSummary,
  StoreSettings,
} from '../../domain/store.types.js';
import { firstNameOf } from '../../domain/store.types.js';

// Réplica en memoria de la lógica de la migración 010 para pruebas rápidas de integración (sin PostgreSQL):
// mismas reglas, mismos códigos de error y la misma atomicidad (las operaciones se serializan con una cola).
// La concurrencia real se prueba contra PostgreSQL (database/tests/store-race.sh y la suite PostgreSQL).

export type ZoneState = 'active' | 'inactive' | 'missing';

export interface InMemoryStoreOptions {
  /** Estado de una zona; por defecto todas están activas. */
  readonly zoneState?: (zoneId: string) => Promise<ZoneState> | ZoneState;
  /** Reloj; por defecto, la hora actual. Útil para probar franjas. */
  readonly now?: () => Date;
  /** Datos del cliente para los avisos por correo; por defecto, sin correo. */
  readonly userInfo?: (userId: string) => { email: string | null; displayName: string | null; verifiedVia: string | null };
  /** Nombre visible de un conductor en la caja del administrador. */
  readonly courierName?: (userId: string) => string | null;
}

type OrderStatus = 'pendiente' | 'asignado_a_ruta' | 'recogido' | 'en_camino' | 'entregado' | 'entrega_fallida' | 'cancelado';

// Misma máquina de estados que el disparador guard_order de la migración 011.
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pendiente: ['asignado_a_ruta', 'cancelado'],
  asignado_a_ruta: ['pendiente', 'recogido', 'cancelado'],
  recogido: ['en_camino'],
  en_camino: ['entregado', 'entrega_fallida'],
  entrega_fallida: ['pendiente', 'cancelado'],
  entregado: [],
  cancelado: [],
};

interface StoredStop {
  routeId: string;
  courierUserId: string;
  routeStatus: 'asignada' | 'en_curso';
  position: number;
}

interface StoredAddress {
  id: string;
  userId: string;
  label: string;
  zoneId: string;
  address: string;
  recipientName: string | null;
  recipientPhone: string | null;
  isDefault: boolean;
  version: number;
  touched: number;
  latitude: number | null;
  longitude: number | null;
}

interface StoredNotification {
  id: string;
  userId: string;
  orderId: string;
  version: number;
  kind: NotificationKind;
  statusTo: string | null;
  state: 'pendiente' | 'enviada' | 'omitida' | 'fallida';
  attempts: number;
  locked: boolean;
}

interface StoredProduct {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  description: string | null;
  categoryId: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  stockQuantity: number;
  imageKey: string | null;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredOrder {
  id: string;
  customerId: string;
  zoneId: string;
  deliveryAddress: string;
  deliveryDate: string;
  deliveryTime: string;
  recipientName: string | null;
  recipientPhone: string | null;
  notes: string | null;
  totalCents: number;
  lines: StoreOrderLine[];
  createdAt: Date;
  latitude: number | null;
  longitude: number | null;
  status: OrderStatus;
  version: number;
  stop: StoredStop | null;
  failures: Array<{ attempt: number; reason: FailureReason; note: string | null; courierUserId: string; at: Date }>;
  collection: { amountCents: number; courierUserId: string; at: Date } | null;
  cancellation: { reason: CancelReason; note: string | null; actorId: string; restocked: boolean } | null;
  history: Array<{ status: OrderStatus; at: Date }>;
}

const DEFAULT_SETTINGS: StoreSettings = { slotCapacity: 10, firstSlotHour: 8, lastSlotHour: 20, minLeadMinutes: 60 };

const searchText = (value: string): string =>
  value.toLowerCase().replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n');

const tokens = (value: string): string[] => searchText(value).split(/[^a-z0-9]+/).filter((token) => token !== '');
// Como en SQL (store_search_query): la consulta usa a lo sumo 8 palabras; el texto del producto se indexa completo.
const queryTokens = (value: string): string[] => tokens(value).slice(0, 8);

function discountPercent(price: number, compareAt: number | null): number | null {
  return compareAt === null ? null : Math.round((100 * (compareAt - price)) / compareAt);
}

export class InMemoryStoreRepository implements CatalogRepository, StoreOrderRepository, FlowsRepository {
  private readonly categories = new Map<string, { id: string; name: string; isActive: boolean; version: number }>();
  private readonly products = new Map<string, StoredProduct>();
  private readonly events = new Map<string, ProductEvent[]>();
  private readonly ledger: Array<{ productId: string; orderId: string | null; delta: number; reason: string }> = [];
  private readonly orders = new Map<string, StoredOrder>();
  private readonly requests = new Map<string, { hash: string; result: PlaceOrderResult }>();
  private readonly addresses: StoredAddress[] = [];
  private readonly settlements: Array<{ courierUserId: string; date: string; expectedCents: number; receivedCents: number; note: string | null; at: Date }> = [];
  private readonly notifications: StoredNotification[] = [];
  private readonly flowRequests = new Map<string, { hash: string; result: DeliveryOutcome }>();
  private readonly couriers = new Set<string>();
  private touchCounter = 0;
  private settings: StoreSettings = { ...DEFAULT_SETTINGS };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: InMemoryStoreOptions = {}) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  /** Cola de ejecución: cada operación de escritura termina antes de que empiece la siguiente (como un candado). */
  private serialized<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private record(productId: string, action: string, actorId: string | null, changes: Record<string, unknown>): void {
    const list = this.events.get(productId) ?? [];
    list.unshift({ id: randomUUID(), action, actorUserId: actorId, changes, createdAt: this.now().toISOString() });
    this.events.set(productId, list);
  }

  private view(product: StoredProduct): Product {
    const category = this.categories.get(product.categoryId);
    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      description: product.description,
      category: { id: product.categoryId, name: category?.name ?? '' },
      priceCents: product.priceCents,
      compareAtPriceCents: product.compareAtPriceCents,
      discountPercent: discountPercent(product.priceCents, product.compareAtPriceCents),
      stockQuantity: product.stockQuantity,
      imageKey: product.imageKey,
      isActive: product.isActive,
      version: product.version,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    };
  }

  private orderable(product: StoredProduct): boolean {
    return product.isActive && (this.categories.get(product.categoryId)?.isActive ?? false);
  }

  // --------------------------------------------------------------------------------------------- categorías

  async listCategories(includeInactive: boolean): Promise<readonly Category[]> {
    return [...this.categories.values()]
      .filter((category) => includeInactive || category.isActive)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map((category) => ({ ...category }));
  }

  createCategory(name: string, _actorId: string): Promise<Category> {
    return this.serialized(() => {
      if ([...this.categories.values()].some((category) => category.name.toLowerCase() === name.toLowerCase())) {
        throw new StoreError('DUPLICATE_CATEGORY');
      }
      const category = { id: randomUUID(), name, isActive: true, version: 1 };
      this.categories.set(category.id, category);
      return { ...category };
    });
  }

  updateCategory(id: string, patch: { name?: string; isActive?: boolean }, expectedVersion: number, _actorId: string): Promise<Category> {
    return this.serialized(() => {
      const category = this.categories.get(id);
      if (!category) throw new StoreError('CATEGORY_NOT_FOUND');
      if (category.version !== expectedVersion) throw new StoreError('VERSION_CONFLICT');
      const name = patch.name;
      if (name !== undefined && [...this.categories.values()].some((other) => other.id !== id && other.name.toLowerCase() === name.toLowerCase())) {
        throw new StoreError('DUPLICATE_CATEGORY');
      }
      if (name !== undefined) category.name = name;
      if (patch.isActive !== undefined) category.isActive = patch.isActive;
      category.version += 1;
      return { ...category };
    });
  }

  // --------------------------------------------------------------------------------------------- productos

  async listProducts(filter: ProductFilter): Promise<Page<Product>> {
    const words = filter.q === undefined ? [] : queryTokens(filter.q);
    const matches = [...this.products.values()].filter((product) => {
      const category = this.categories.get(product.categoryId);
      const visible = product.isActive && (category?.isActive ?? false);
      if (filter.status === 'active' && !visible) return false;
      if (filter.status === 'inactive' && visible) return false;
      if (filter.categoryId !== undefined && product.categoryId !== filter.categoryId) return false;
      if (filter.minPriceCents !== undefined && product.priceCents < filter.minPriceCents) return false;
      if (filter.maxPriceCents !== undefined && product.priceCents > filter.maxPriceCents) return false;
      if (filter.onSale && product.compareAtPriceCents === null) return false;
      if (words.length > 0) {
        const haystack = tokens(`${product.name} ${product.brand ?? ''} ${product.description ?? ''} ${category?.name ?? ''}`);
        if (!words.every((word) => haystack.some((candidate) => candidate.startsWith(word)))) return false;
      }
      return true;
    });
    const byNewest = (a: StoredProduct, b: StoredProduct) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id);
    matches.sort((a, b) => {
      switch (filter.sort) {
        case 'price_asc': return a.priceCents - b.priceCents || byNewest(a, b);
        case 'price_desc': return b.priceCents - a.priceCents || byNewest(a, b);
        case 'discount': return (discountPercent(b.priceCents, b.compareAtPriceCents) ?? -1) - (discountPercent(a.priceCents, a.compareAtPriceCents) ?? -1) || byNewest(a, b);
        default: return byNewest(a, b);
      }
    });
    const start = (filter.page - 1) * filter.pageSize;
    return { items: matches.slice(start, start + filter.pageSize).map((product) => this.view(product)), page: filter.page, pageSize: filter.pageSize, total: matches.length };
  }

  async getProduct(id: string, includeInactive: boolean): Promise<Product | null> {
    const product = this.products.get(id);
    if (!product || (!includeInactive && !this.orderable(product))) return null;
    return this.view(product);
  }

  createProduct(input: NewProduct, actorId: string): Promise<Product> {
    return this.serialized(() => {
      if ([...this.products.values()].some((product) => product.sku === input.sku)) throw new StoreError('DUPLICATE_SKU');
      if (!this.categories.has(input.categoryId)) throw new StoreError('CATEGORY_NOT_FOUND');
      if (input.compareAtPriceCents !== null && input.compareAtPriceCents <= input.priceCents) throw new StoreError('VALIDATION_ERROR');
      const now = this.now();
      const product: StoredProduct = {
        id: randomUUID(), sku: input.sku, name: input.name, brand: input.brand, description: input.description,
        categoryId: input.categoryId, priceCents: input.priceCents, compareAtPriceCents: input.compareAtPriceCents,
        stockQuantity: input.stock, imageKey: input.imageKey, isActive: input.isActive, version: 1, createdAt: now, updatedAt: now,
      };
      this.products.set(product.id, product);
      if (input.stock > 0) this.ledger.push({ productId: product.id, orderId: null, delta: input.stock, reason: 'initial' });
      this.record(product.id, 'created', actorId, { sku: input.sku, priceCents: input.priceCents, stock: input.stock });
      return this.view(product);
    });
  }

  updateProduct(id: string, patch: ProductPatch, expectedVersion: number, actorId: string): Promise<Product> {
    return this.serialized(() => {
      const product = this.products.get(id);
      if (!product) throw new StoreError('PRODUCT_NOT_FOUND');
      if (product.version !== expectedVersion) throw new StoreError('VERSION_CONFLICT');
      const next = { ...product };
      const changes: Record<string, unknown> = {};
      const set = <K extends keyof StoredProduct>(key: K, value: StoredProduct[K]) => {
        if (next[key] !== value) { changes[key] = { from: next[key], to: value }; next[key] = value; }
      };
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.brand !== undefined) set('brand', patch.brand);
      if (patch.description !== undefined) set('description', patch.description);
      if (patch.categoryId !== undefined) {
        if (!this.categories.has(patch.categoryId)) throw new StoreError('CATEGORY_NOT_FOUND');
        set('categoryId', patch.categoryId);
      }
      if (patch.priceCents !== undefined) set('priceCents', patch.priceCents);
      if (patch.compareAtPriceCents !== undefined) set('compareAtPriceCents', patch.compareAtPriceCents);
      if (patch.imageKey !== undefined) set('imageKey', patch.imageKey);
      if (patch.isActive !== undefined) set('isActive', patch.isActive);
      if (next.compareAtPriceCents !== null && next.compareAtPriceCents <= next.priceCents) throw new StoreError('VALIDATION_ERROR');
      next.version += 1;
      next.updatedAt = this.now();
      this.products.set(id, next);
      const onlyActive = Object.keys(changes).length === 1 && 'isActive' in changes;
      this.record(id, onlyActive ? (next.isActive ? 'activated' : 'deactivated') : 'updated', actorId, changes);
      return this.view(next);
    });
  }

  adjustStock(id: string, delta: number, reason: StockReason, actorId: string): Promise<{ readonly id: string; readonly stock: number }> {
    return this.serialized(() => {
      const product = this.products.get(id);
      if (!product) throw new StoreError('PRODUCT_NOT_FOUND');
      if (product.stockQuantity + delta < 0) throw new StoreError('INSUFFICIENT_STOCK');
      product.stockQuantity += delta;
      product.updatedAt = this.now();
      this.ledger.push({ productId: id, orderId: null, delta, reason });
      this.record(id, 'stock_adjusted', actorId, { delta, reason, balance: product.stockQuantity });
      return { id, stock: product.stockQuantity };
    });
  }

  async listProductEvents(id: string, limit: number): Promise<readonly ProductEvent[]> {
    return (this.events.get(id) ?? []).slice(0, limit);
  }

  async getSettings(): Promise<StoreSettings> {
    return { ...this.settings };
  }

  updateSettings(settings: StoreSettings, _actorId: string): Promise<StoreSettings> {
    return this.serialized(() => {
      this.settings = { ...settings };
      return { ...this.settings };
    });
  }

  // --------------------------------------------------------------------------------------------- franjas y pedidos

  private ecuadorNow(): Date {
    // Ecuador continental no usa horario de verano: UTC-5 todo el año.
    return new Date(this.now().getTime() - 5 * 3_600_000);
  }

  private reserved(zoneId: string, date: string, hour: number, excludeId?: string): number {
    return [...this.orders.values()].filter(
      (order) =>
        order.zoneId === zoneId && order.deliveryDate === date && Number(order.deliveryTime.slice(0, 2)) === hour &&
        order.status !== 'cancelado' && order.id !== excludeId,
    ).length;
  }

  private slotStart(date: string, hour: number): number {
    return Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  }

  async deliverySlots(zoneId: string, date: string): Promise<readonly DeliverySlot[] | null> {
    const state = await (this.options.zoneState ?? (() => 'active' as ZoneState))(zoneId);
    if (state !== 'active') return null;
    const earliest = this.ecuadorNow().getTime() + this.settings.minLeadMinutes * 60_000;
    const slots: DeliverySlot[] = [];
    for (let hour = this.settings.firstSlotHour; hour <= this.settings.lastSlotHour; hour += 1) {
      const reserved = this.reserved(zoneId, date, hour);
      slots.push({
        time: `${String(hour).padStart(2, '0')}:00`,
        capacity: this.settings.slotCapacity,
        reserved,
        available: this.slotStart(date, hour) >= earliest && reserved < this.settings.slotCapacity,
      });
    }
    return slots;
  }

  placeOrder(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    return this.serialized(async () => {
      const items = [...command.items].sort((a, b) => a.productId.localeCompare(b.productId));
      const hash = JSON.stringify({
        zone: command.zoneId, address: command.deliveryAddress, date: command.deliveryDate, time: command.deliveryTime,
        recipient: command.recipientName, phone: command.recipientPhone, notes: command.notes, items,
        lat: command.latitude, lng: command.longitude,
      });
      const requestKey = `${command.customerId}:${command.idempotencyKey}`;
      const previous = this.requests.get(requestKey);
      if (previous) {
        if (previous.hash !== hash) throw new StoreError('IDEMPOTENCY_KEY_REUSED');
        return { ...previous.result, replayed: true };
      }
      const finish = (result: PlaceOrderResult): PlaceOrderResult => {
        this.requests.set(requestKey, { hash, result });
        return result;
      };
      const conflict = (conflicts: OrderConflict[]): PlaceOrderResult => finish({ status: 'conflict', conflicts, replayed: false });

      const zone = await (this.options.zoneState ?? (() => 'active' as ZoneState))(command.zoneId);
      if (zone === 'missing') throw new StoreError('ZONE_NOT_FOUND');
      if (zone === 'inactive') return conflict([{ reason: 'zone_inactive' }]);

      const hour = Number(command.deliveryTime.slice(0, 2));
      if (command.deliveryTime.slice(3) !== '00' || hour < this.settings.firstSlotHour || hour > this.settings.lastSlotHour) {
        return conflict([{ reason: 'slot_invalid' }]);
      }
      if (this.slotStart(command.deliveryDate, hour) < this.ecuadorNow().getTime() + this.settings.minLeadMinutes * 60_000) {
        return conflict([{ reason: 'slot_unavailable' }]);
      }
      if (this.reserved(command.zoneId, command.deliveryDate, hour) >= this.settings.slotCapacity) {
        return conflict([{ reason: 'slot_full', capacity: this.settings.slotCapacity }]);
      }

      const conflicts: OrderConflict[] = [];
      for (const item of items) {
        const product = this.products.get(item.productId);
        if (!product || !this.orderable(product)) conflicts.push({ reason: 'unavailable', productId: item.productId });
        else if (product.priceCents !== item.unitPriceCents) conflicts.push({ reason: 'price_changed', productId: item.productId, currentPriceCents: product.priceCents });
        else if (product.stockQuantity < item.quantity) conflicts.push({ reason: 'insufficient_stock', productId: item.productId, available: product.stockQuantity });
      }
      if (conflicts.length > 0) return conflict(conflicts);

      const order: StoredOrder = {
        id: randomUUID(), customerId: command.customerId, zoneId: command.zoneId, deliveryAddress: command.deliveryAddress,
        deliveryDate: command.deliveryDate, deliveryTime: command.deliveryTime, recipientName: command.recipientName,
        recipientPhone: command.recipientPhone, notes: command.notes, totalCents: 0, lines: [], createdAt: this.now(),
        latitude: command.latitude, longitude: command.longitude,
        status: 'pendiente', version: 1, stop: null, failures: [], collection: null, cancellation: null,
        history: [],
      };
      order.history.push({ status: 'pendiente', at: order.createdAt });
      for (const item of items) {
        const product = this.products.get(item.productId) as StoredProduct;
        product.stockQuantity -= item.quantity;
        this.ledger.push({ productId: product.id, orderId: order.id, delta: -item.quantity, reason: 'sale' });
        const lineTotal = product.priceCents * item.quantity;
        order.totalCents += lineTotal;
        order.lines.push({
          productId: product.id, sku: product.sku, name: product.name, unitPriceCents: product.priceCents,
          quantity: item.quantity, lineTotalCents: lineTotal, imageKey: product.imageKey,
        });
      }
      order.lines.sort((a, b) => a.name.localeCompare(b.name) || a.productId.localeCompare(b.productId));
      this.orders.set(order.id, order);
      this.enqueue(order, 'order_confirmed', null);
      return finish({ status: 'ok', orderId: order.id, totalCents: order.totalCents, itemsCount: order.lines.length, replayed: false });
    });
  }

  private orderSummary(order: StoredOrder): StoreOrderSummary {
    return {
      id: order.id, status: order.status, zoneId: order.zoneId, deliveryAddress: order.deliveryAddress,
      deliveryDate: order.deliveryDate, deliveryTime: order.deliveryTime, totalCents: order.totalCents,
      itemsCount: order.lines.length, paymentMethod: 'contra_entrega', createdAt: order.createdAt.toISOString(),
      deliveryLatitude: order.latitude, deliveryLongitude: order.longitude,
    };
  }

  async listOrders(scope: OrderScope, paging: { readonly page: number; readonly pageSize: number }): Promise<Page<StoreOrderSummary>> {
    const all = [...this.orders.values()]
      .filter((order) => scope.customerId === undefined || order.customerId === scope.customerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const start = (paging.page - 1) * paging.pageSize;
    return { items: all.slice(start, start + paging.pageSize).map((order) => this.orderSummary(order)), page: paging.page, pageSize: paging.pageSize, total: all.length };
  }

  async getOrder(id: string, scope: OrderScope): Promise<StoreOrderDetail | null> {
    const order = this.orders.get(id);
    if (!order || (scope.customerId !== undefined && order.customerId !== scope.customerId)) return null;
    const firstName = order.stop === null ? null : firstNameOf(this.options.courierName?.(order.stop.courierUserId));
    return {
      ...this.orderSummary(order), customerId: order.customerId, recipientName: order.recipientName,
      recipientPhone: order.recipientPhone, notes: order.notes,
      items: order.lines.map((line) => ({ ...line, imageKey: this.products.get(line.productId)?.imageKey ?? null })),
      history: order.history.map((event) => ({ status: event.status, at: event.at.toISOString() })),
      courier: firstName === null ? null : { firstName },
    };
  }

  // =============================================================================================
  // Flujos por rol (réplica de la migración 011)
  // =============================================================================================

  private ecuadorDate(at: Date): string {
    return new Date(at.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
  }

  private detail(order: StoredOrder): StoreOrderDetail {
    return {
      ...this.orderSummary(order), customerId: order.customerId, recipientName: order.recipientName,
      recipientPhone: order.recipientPhone, notes: order.notes,
      items: order.lines.map((line) => ({ ...line, imageKey: this.products.get(line.productId)?.imageKey ?? null })),
    };
  }

  /** Cambia el estado con las mismas reglas del disparador de la base y deja el aviso al cliente en la cola. */
  private move(order: StoredOrder, to: OrderStatus): void {
    if (!TRANSITIONS[order.status].includes(to)) throw new StoreError('STALE_ORDER');
    const from = order.status;
    order.status = to;
    order.version += 1;
    order.history.push({ status: to, at: this.now() });
    if (to === 'cancelado') this.enqueue(order, 'order_cancelled', to);
    else if (to === 'en_camino' || to === 'entregado' || to === 'entrega_fallida') this.enqueue(order, 'order_status', to);
    else if (from === 'entrega_fallida' && to === 'pendiente') this.enqueue(order, 'order_rescheduled', to);
  }

  private enqueue(order: StoredOrder, kind: NotificationKind, statusTo: string | null): void {
    this.notifications.push({
      id: randomUUID(), userId: order.customerId, orderId: order.id, version: order.version, kind, statusTo,
      state: 'pendiente', attempts: 0, locked: false,
    });
  }

  private ownedOrder(orderId: string, actor: FlowActor): StoredOrder {
    const order = this.orders.get(orderId);
    if (!order || (actor.role === 'cliente' && order.customerId !== actor.id)) throw new StoreError('ORDER_NOT_FOUND');
    return order;
  }

  private slotProblem(zoneId: string, date: string, time: string, excludeId: string): 'slot_invalid' | 'slot_unavailable' | 'slot_full' | null {
    const hour = Number(time.slice(0, 2));
    if (time.slice(3) !== '00' || hour < this.settings.firstSlotHour || hour > this.settings.lastSlotHour) return 'slot_invalid';
    if (this.slotStart(date, hour) < this.ecuadorNow().getTime() + this.settings.minLeadMinutes * 60_000) return 'slot_unavailable';
    if (this.reserved(zoneId, date, hour, excludeId) >= this.settings.slotCapacity) return 'slot_full';
    return null;
  }

  cancelOrder(input: { orderId: string; actor: FlowActor; reason: CancelReason; note: string | null }): Promise<CancelResult> {
    return this.serialized(() => {
      const order = this.ownedOrder(input.orderId, input.actor);
      if (order.status === 'cancelado') return { status: 'cancelado' as const, alreadyCancelled: true, restocked: false, version: order.version };
      const closedFailure = order.status === 'entrega_fallida' && order.stop !== null;
      if (!['pendiente', 'asignado_a_ruta', 'entrega_fallida'].includes(order.status) || closedFailure) throw new StoreError('ORDER_NOT_CANCELLABLE');
      if (order.status === 'asignado_a_ruta' && order.stop !== null) {
        const others = [...this.orders.values()].filter((other) => other.id !== order.id && other.stop?.routeId === order.stop?.routeId).length;
        // Una ruta en curso no puede quedar vacía: la última parada la cierra el conductor como fallida.
        if (order.stop.routeStatus === 'en_curso' && others === 0) throw new StoreError('ORDER_NOT_CANCELLABLE');
      }
      order.stop = null;
      this.move(order, 'cancelado');
      for (const line of order.lines) {
        const product = this.products.get(line.productId);
        if (!product) continue;
        product.stockQuantity += line.quantity;
        product.updatedAt = this.now();
        this.ledger.push({ productId: product.id, orderId: order.id, delta: line.quantity, reason: 'cancel' });
      }
      order.cancellation = { reason: input.reason, note: input.note, actorId: input.actor.id, restocked: true };
      return { status: 'cancelado' as const, alreadyCancelled: false, restocked: true, version: order.version };
    });
  }

  rescheduleOrder(input: { orderId: string; actor: FlowActor; deliveryDate: string; deliveryTime: string }): Promise<RescheduleResult> {
    return this.serialized(() => {
      const order = this.ownedOrder(input.orderId, input.actor);
      if (order.status !== 'entrega_fallida' || order.stop !== null) throw new StoreError('ORDER_NOT_RESCHEDULABLE');
      if (order.failures.length >= MAX_DELIVERY_ATTEMPTS) throw new StoreError('MAX_DELIVERY_ATTEMPTS');
      if (input.deliveryDate < this.ecuadorDate(this.now())) throw new StoreError('VALIDATION_ERROR', 'La fecha de entrega no puede ser anterior a hoy.');
      const problem = this.slotProblem(order.zoneId, input.deliveryDate, input.deliveryTime, order.id);
      if (problem !== null) return { status: 'conflict' as const, reason: problem };
      order.deliveryDate = input.deliveryDate;
      order.deliveryTime = input.deliveryTime;
      this.move(order, 'pendiente');
      return { status: 'ok' as const, orderId: order.id, orderStatus: 'pendiente' as const, version: order.version };
    });
  }

  // --------------------------------------------------------------------------------------------- conductor

  async courierOrders(courierUserId: string): Promise<readonly CourierOrder[]> {
    return [...this.orders.values()]
      .filter((order) => order.stop?.courierUserId === courierUserId)
      .sort((a, b) =>
        a.deliveryDate.localeCompare(b.deliveryDate) || (a.stop?.routeId ?? '').localeCompare(b.stop?.routeId ?? '') ||
        (a.stop?.position ?? 0) - (b.stop?.position ?? 0))
      .map((order) => ({
        orderId: order.id, version: order.version, status: order.status, routeId: order.stop?.routeId ?? '',
        routeStatus: order.stop?.routeStatus ?? '', position: order.stop?.position ?? 0, deliveryAddress: order.deliveryAddress,
        deliveryDate: order.deliveryDate, deliveryTime: order.deliveryTime, recipientName: order.recipientName,
        recipientPhone: order.recipientPhone, notes: order.notes, isStoreOrder: true, totalCents: order.totalCents,
        failedAttempts: order.failures.length, deliveryLatitude: order.latitude, deliveryLongitude: order.longitude,
        items: order.lines.map((line) => ({ name: line.name, quantity: line.quantity, unitPriceCents: line.unitPriceCents, lineTotalCents: line.lineTotalCents })),
      }));
  }

  private courierStop(orderId: string, courierUserId: string, expectedVersion: number): StoredOrder {
    const order = this.orders.get(orderId);
    if (!order || order.stop === null || order.version !== expectedVersion) throw new StoreError('STALE_ORDER');
    if (order.stop.courierUserId !== courierUserId) throw new StoreError('FORBIDDEN');
    return order;
  }

  deliverOrder(input: { orderId: string; courierUserId: string; expectedVersion: number; collectedCents: number; idempotencyKey: string }): Promise<DeliveryOutcome> {
    return this.serialized(() => {
      const requestKey = `deliver:${input.courierUserId}:${input.orderId}:${input.idempotencyKey}`;
      const hash = JSON.stringify({ v: input.expectedVersion, c: input.collectedCents });
      const previous = this.flowRequests.get(requestKey);
      if (previous) {
        if (previous.hash !== hash) throw new StoreError('IDEMPOTENCY_KEY_REUSED');
        return { ...previous.result, replayed: true };
      }
      const order = this.orders.get(input.orderId);
      if (!order) throw new StoreError('NOT_A_STORE_ORDER');
      if (input.collectedCents !== order.totalCents) throw new StoreError('COLLECTION_AMOUNT_MISMATCH');
      this.courierStop(input.orderId, input.courierUserId, input.expectedVersion);
      if (order.status !== 'en_camino') throw new StoreError('STALE_ORDER');
      order.collection = { amountCents: input.collectedCents, courierUserId: input.courierUserId, at: this.now() };
      this.move(order, 'entregado');
      const result: DeliveryOutcome = { orderId: order.id, status: 'entregado', version: order.version, collectedCents: input.collectedCents, replayed: false };
      this.flowRequests.set(requestKey, { hash, result });
      return result;
    });
  }

  failDelivery(input: { orderId: string; courierUserId: string; expectedVersion: number; reason: FailureReason; note: string | null; idempotencyKey: string }): Promise<DeliveryOutcome> {
    return this.serialized(() => {
      const requestKey = `fail:${input.courierUserId}:${input.orderId}:${input.idempotencyKey}`;
      const hash = JSON.stringify({ v: input.expectedVersion, r: input.reason, n: input.note });
      const previous = this.flowRequests.get(requestKey);
      if (previous) {
        if (previous.hash !== hash) throw new StoreError('IDEMPOTENCY_KEY_REUSED');
        return { ...previous.result, replayed: true };
      }
      const order = this.courierStop(input.orderId, input.courierUserId, input.expectedVersion);
      if (order.status !== 'en_camino') throw new StoreError('STALE_ORDER');
      const attempt = order.failures.length + 1;
      if (attempt > MAX_DELIVERY_ATTEMPTS) throw new StoreError('MAX_DELIVERY_ATTEMPTS');
      order.failures.push({ attempt, reason: input.reason, note: input.note, courierUserId: input.courierUserId, at: this.now() });
      this.move(order, 'entrega_fallida');
      const result: DeliveryOutcome = { orderId: order.id, status: 'entrega_fallida', version: order.version, attempt, replayed: false };
      this.flowRequests.set(requestKey, { hash, result });
      return result;
    });
  }

  // --------------------------------------------------------------------------------------------- caja

  private collectedOn(courierUserId: string, date: string): { cents: number; count: number } {
    const rows = [...this.orders.values()].filter(
      (order) => order.collection?.courierUserId === courierUserId && this.ecuadorDate(order.collection.at) === date,
    );
    return { cents: rows.reduce((total, order) => total + (order.collection?.amountCents ?? 0), 0), count: rows.length };
  }

  private settlementView(courierUserId: string, date: string): CourierCash['settlement'] {
    const row = this.settlements.find((entry) => entry.courierUserId === courierUserId && entry.date === date);
    return row ? { receivedCents: row.receivedCents, differenceCents: row.receivedCents - row.expectedCents, settledAt: row.at.toISOString() } : null;
  }

  async courierCash(courierUserId: string, date: string): Promise<CourierCash> {
    const total = this.collectedOn(courierUserId, date);
    return { date, collectedCents: total.cents, ordersCount: total.count, settlement: this.settlementView(courierUserId, date) };
  }

  async adminCash(date: string): Promise<readonly AdminCashRow[]> {
    const ids = new Set<string>();
    for (const order of this.orders.values()) if (order.collection && this.ecuadorDate(order.collection.at) === date) ids.add(order.collection.courierUserId);
    return [...ids].map((id) => ({ id, name: this.options.courierName?.(id) ?? null })).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id)).map(({ id, name }) => {
      const total = this.collectedOn(id, date);
      return { date, courierUserId: id, courierName: name, collectedCents: total.cents, ordersCount: total.count, settlement: this.settlementView(id, date) };
    });
  }

  settleCash(input: { courierUserId: string; date: string; receivedCents: number; note: string | null; actorId: string }): Promise<SettlementResult> {
    return this.serialized(() => {
      if (!this.couriers.has(input.courierUserId) && this.collectedOn(input.courierUserId, input.date).cents === 0) throw new StoreError('COURIER_NOT_FOUND');
      const expected = this.collectedOn(input.courierUserId, input.date).cents;
      if (expected === 0) throw new StoreError('NOTHING_TO_SETTLE');
      if (this.settlements.some((entry) => entry.courierUserId === input.courierUserId && entry.date === input.date)) throw new StoreError('ALREADY_SETTLED');
      this.settlements.push({ courierUserId: input.courierUserId, date: input.date, expectedCents: expected, receivedCents: input.receivedCents, note: input.note, at: this.now() });
      return { expectedCents: expected, receivedCents: input.receivedCents, differenceCents: input.receivedCents - expected };
    });
  }

  // --------------------------------------------------------------------------------------------- direcciones

  private addressView(row: StoredAddress): Address {
    return {
      id: row.id, label: row.label, zoneId: row.zoneId, address: row.address, recipientName: row.recipientName,
      recipientPhone: row.recipientPhone, isDefault: row.isDefault, version: row.version,
      latitude: row.latitude, longitude: row.longitude,
    };
  }

  private async activeZone(zoneId: string): Promise<void> {
    if ((await (this.options.zoneState ?? (() => 'active' as ZoneState))(zoneId)) !== 'active') throw new StoreError('ZONE_NOT_FOUND');
  }

  async listAddresses(userId: string): Promise<readonly Address[]> {
    return this.addresses
      .filter((row) => row.userId === userId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id))
      .map((row) => this.addressView(row));
  }

  createAddress(userId: string, input: NewAddress): Promise<Address> {
    return this.serialized(async () => {
      await this.activeZone(input.zoneId);
      const mine = this.addresses.filter((row) => row.userId === userId);
      if (mine.length >= MAX_ADDRESSES) throw new StoreError('ADDRESS_LIMIT');
      if (mine.some((row) => row.label.toLowerCase() === input.label.toLowerCase())) throw new StoreError('DUPLICATE_ADDRESS');
      const makeDefault = input.isDefault || mine.length === 0;
      if (makeDefault) for (const row of mine) if (row.isDefault) { row.isDefault = false; row.version += 1; row.touched = ++this.touchCounter; }
      const row: StoredAddress = {
        id: randomUUID(), userId, label: input.label, zoneId: input.zoneId, address: input.address, recipientName: input.recipientName,
        recipientPhone: input.recipientPhone, isDefault: makeDefault, version: 1, touched: ++this.touchCounter,
        latitude: input.latitude, longitude: input.longitude,
      };
      this.addresses.push(row);
      return this.addressView(row);
    });
  }

  updateAddress(userId: string, id: string, patch: AddressPatch, expectedVersion: number): Promise<Address> {
    return this.serialized(async () => {
      const row = this.addresses.find((entry) => entry.id === id && entry.userId === userId);
      if (!row) throw new StoreError('ADDRESS_NOT_FOUND');
      if (row.version !== expectedVersion) throw new StoreError('VERSION_CONFLICT');
      if (patch.zoneId !== undefined) await this.activeZone(patch.zoneId);
      if (patch.isDefault === false && row.isDefault) {
        throw new StoreError('VALIDATION_ERROR', 'Debe haber una dirección predeterminada: marca otra como predeterminada.');
      }
      if (patch.label !== undefined && this.addresses.some((other) => other.userId === userId && other.id !== id && other.label.toLowerCase() === patch.label?.toLowerCase())) {
        throw new StoreError('DUPLICATE_ADDRESS');
      }
      if (patch.isDefault === true) {
        for (const other of this.addresses) if (other.userId === userId && other.isDefault && other.id !== id) { other.isDefault = false; other.version += 1; other.touched = ++this.touchCounter; }
      }
      if (patch.label !== undefined) row.label = patch.label;
      if (patch.zoneId !== undefined) row.zoneId = patch.zoneId;
      if (patch.address !== undefined) row.address = patch.address;
      if (patch.recipientName !== undefined) row.recipientName = patch.recipientName;
      if (patch.recipientPhone !== undefined) row.recipientPhone = patch.recipientPhone;
      if (patch.isDefault !== undefined) row.isDefault = patch.isDefault;
      if (patch.latitude !== undefined) row.latitude = patch.latitude;
      if (patch.longitude !== undefined) row.longitude = patch.longitude;
      row.version += 1;
      row.touched = ++this.touchCounter;
      return this.addressView(row);
    });
  }

  deleteAddress(userId: string, id: string): Promise<void> {
    return this.serialized(() => {
      const index = this.addresses.findIndex((entry) => entry.id === id && entry.userId === userId);
      const removed = this.addresses[index];
      if (!removed) throw new StoreError('ADDRESS_NOT_FOUND');
      this.addresses.splice(index, 1);
      if (removed.isDefault) {
        const next = this.addresses.filter((row) => row.userId === userId).sort((a, b) => b.touched - a.touched || a.id.localeCompare(b.id))[0];
        if (next) { next.isDefault = true; next.version += 1; next.touched = ++this.touchCounter; }
      }
    });
  }

  // --------------------------------------------------------------------------------------------- despacho y reportes

  async listOrderDetails(filter: AdminOrderFilter, paging: { readonly page: number; readonly pageSize: number }): Promise<Page<StoreOrderDetail>> {
    const all = [...this.orders.values()]
      .filter((order) =>
        (filter.status === undefined || order.status === filter.status) &&
        (filter.deliveryDate === undefined || order.deliveryDate === filter.deliveryDate) &&
        (filter.zoneId === undefined || order.zoneId === filter.zoneId))
      .sort((a, b) =>
        a.deliveryDate.localeCompare(b.deliveryDate) || a.deliveryTime.localeCompare(b.deliveryTime) ||
        a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const start = (paging.page - 1) * paging.pageSize;
    return { items: all.slice(start, start + paging.pageSize).map((order) => this.detail(order)), page: paging.page, pageSize: paging.pageSize, total: all.length };
  }

  async lowStock(threshold: number, limit: number): Promise<readonly LowStockItem[]> {
    return [...this.products.values()]
      .filter((product) => product.stockQuantity <= threshold)
      .sort((a, b) => a.stockQuantity - b.stockQuantity || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((product) => ({ id: product.id, sku: product.sku, name: product.name, stockQuantity: product.stockQuantity, isActive: product.isActive }));
  }

  async summary(from: string, to: string): Promise<SalesSummary> {
    const inRange = (date: string): boolean => date >= from && date <= to;
    const orders = [...this.orders.values()].filter((order) => inRange(order.deliveryDate));
    const count = (values: string[]): Record<string, number> => {
      const result: Record<string, number> = {};
      for (const value of values) result[value] = (result[value] ?? 0) + 1;
      return result;
    };
    const live = orders.filter((order) => order.status !== 'cancelado');
    const cancelled = orders.filter((order) => order.cancellation !== null);
    const failures = [...this.orders.values()].flatMap((order) => order.failures).filter((failure) => inRange(this.ecuadorDate(failure.at)));
    const collected = [...this.orders.values()].filter((order) => order.collection && inRange(this.ecuadorDate(order.collection.at)));
    const byProduct = new Map<string, { name: string; units: number; revenueCents: number }>();
    for (const order of live) {
      for (const line of order.lines) {
        const entry = byProduct.get(line.productId) ?? { name: line.name, units: 0, revenueCents: 0 };
        entry.units += line.quantity;
        entry.revenueCents += line.lineTotalCents;
        byProduct.set(line.productId, entry);
      }
    }
    return {
      from, to,
      orders: { total: orders.length, byStatus: count(orders.map((order) => order.status)) },
      grossCents: live.reduce((total, order) => total + order.totalCents, 0),
      collectedCents: collected.reduce((total, order) => total + (order.collection?.amountCents ?? 0), 0),
      cancellations: { count: cancelled.length, byReason: count(cancelled.map((order) => order.cancellation?.reason ?? 'otro')) },
      failures: { count: failures.length, byReason: count(failures.map((failure) => failure.reason)) },
      topProducts: [...byProduct.entries()]
        .map(([productId, entry]) => ({ productId, ...entry }))
        .sort((a, b) => b.units - a.units || b.revenueCents - a.revenueCents || a.productId.localeCompare(b.productId))
        .slice(0, 5)
        .map(({ productId, name, units, revenueCents }) => ({ productId, name, units, revenueCents })),
      lowStockCount: [...this.products.values()].filter((product) => product.isActive && product.stockQuantity <= 5).length,
    };
  }

  // --------------------------------------------------------------------------------------------- avisos por correo

  claimNotifications(limit: number): Promise<readonly PendingNotification[]> {
    return this.serialized(() => {
      const picked = this.notifications.filter((entry) => entry.state === 'pendiente' && !entry.locked).slice(0, Math.min(Math.max(limit, 1), 50));
      return picked.map((entry) => {
        entry.locked = true;
        entry.attempts += 1;
        const user = this.options.userInfo?.(entry.userId) ?? { email: null, displayName: null, verifiedVia: null };
        return {
          id: entry.id, orderId: entry.orderId, kind: entry.kind, statusTo: entry.statusTo, attempts: entry.attempts,
          email: user.email, displayName: user.displayName, emailVerifiedVia: user.verifiedVia,
        };
      });
    });
  }

  finishNotification(id: string, outcome: NotificationOutcome): Promise<void> {
    return this.serialized(() => {
      const entry = this.notifications.find((item) => item.id === id);
      if (!entry) return;
      entry.locked = false;
      if (outcome === 'sent') entry.state = 'enviada';
      else if (outcome === 'skipped') entry.state = 'omitida';
      else entry.state = entry.attempts >= 5 ? 'fallida' : 'pendiente';
    });
  }

  /** Para pruebas: tipos de aviso en cola para un pedido. */
  notificationKinds(orderId: string): string[] {
    return this.notifications.filter((entry) => entry.orderId === orderId).map((entry) => entry.kind);
  }

  /** Para pruebas: cuántos avisos hay en cada estado. */
  notificationStates(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.notifications) result[entry.state] = (result[entry.state] ?? 0) + 1;
    return result;
  }

  // --------------------------------------------------------------------------------------------- simulación de despacho (solo pruebas)
  // El despacho real (rutas, asignación, salida) vive en otros módulos; estas ayudas lo reproducen para probar los flujos.

  registerCourier(userId: string): void {
    this.couriers.add(userId);
  }

  /** Crea una ruta con esos pedidos y la asigna al conductor. Devuelve el id de la ruta. */
  assignToRoute(orderIds: readonly string[], courierUserId: string): string {
    const routeId = randomUUID();
    this.couriers.add(courierUserId);
    orderIds.forEach((id, index) => {
      const order = this.orders.get(id);
      if (!order || order.status !== 'pendiente') throw new Error('Solo se asigna un pedido pendiente.');
      order.stop = { routeId, courierUserId, routeStatus: 'asignada', position: index + 1 };
      this.move(order, 'asignado_a_ruta');
    });
    return routeId;
  }

  advance(orderId: string, to: 'recogido' | 'en_camino'): void {
    const order = this.orders.get(orderId);
    if (!order?.stop) throw new Error('El pedido no está en una ruta.');
    this.move(order, to);
    if (to === 'en_camino') {
      for (const other of this.orders.values()) if (other.stop?.routeId === order.stop.routeId) other.stop.routeStatus = 'en_curso';
    }
  }

  /** Cierra la ruta: todas sus paradas deben estar entregadas o con entrega fallida; las paradas quedan liberadas. */
  closeRoute(routeId: string): void {
    const stops = [...this.orders.values()].filter((order) => order.stop?.routeId === routeId);
    if (stops.length === 0 || stops.some((order) => order.status !== 'entregado' && order.status !== 'entrega_fallida')) {
      throw new Error('La ruta no se puede cerrar.');
    }
    for (const order of stops) order.stop = null;
  }


  /** Para pruebas: suma de movimientos por producto, que debe coincidir con el stock actual. */
  ledgerBalance(productId: string): number {
    return this.ledger.filter((entry) => entry.productId === productId).reduce((total, entry) => total + entry.delta, 0);
  }
}

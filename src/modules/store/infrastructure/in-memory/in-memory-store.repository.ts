import { randomUUID } from 'node:crypto';
import type { CatalogRepository, StoreOrderRepository } from '../../application/ports/store.ports.js';
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

// Réplica en memoria de la lógica de la migración 010 para pruebas rápidas de integración (sin PostgreSQL):
// mismas reglas, mismos códigos de error y la misma atomicidad (las operaciones se serializan con una cola).
// La concurrencia real se prueba contra PostgreSQL (database/tests/store-race.sh y la suite PostgreSQL).

export type ZoneState = 'active' | 'inactive' | 'missing';

export interface InMemoryStoreOptions {
  /** Estado de una zona; por defecto todas están activas. */
  readonly zoneState?: (zoneId: string) => Promise<ZoneState> | ZoneState;
  /** Reloj; por defecto, la hora actual. Útil para probar franjas. */
  readonly now?: () => Date;
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

export class InMemoryStoreRepository implements CatalogRepository, StoreOrderRepository {
  private readonly categories = new Map<string, { id: string; name: string; isActive: boolean; version: number }>();
  private readonly products = new Map<string, StoredProduct>();
  private readonly events = new Map<string, ProductEvent[]>();
  private readonly ledger: Array<{ productId: string; orderId: string | null; delta: number; reason: string }> = [];
  private readonly orders = new Map<string, StoredOrder>();
  private readonly requests = new Map<string, { hash: string; result: PlaceOrderResult }>();
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

  private reserved(zoneId: string, date: string, hour: number): number {
    return [...this.orders.values()].filter(
      (order) => order.zoneId === zoneId && order.deliveryDate === date && Number(order.deliveryTime.slice(0, 2)) === hour,
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
      };
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
      return finish({ status: 'ok', orderId: order.id, totalCents: order.totalCents, itemsCount: order.lines.length, replayed: false });
    });
  }

  private summary(order: StoredOrder): StoreOrderSummary {
    return {
      id: order.id, status: 'pendiente', zoneId: order.zoneId, deliveryAddress: order.deliveryAddress,
      deliveryDate: order.deliveryDate, deliveryTime: order.deliveryTime, totalCents: order.totalCents,
      itemsCount: order.lines.length, paymentMethod: 'contra_entrega', createdAt: order.createdAt.toISOString(),
    };
  }

  async listOrders(scope: OrderScope, paging: { readonly page: number; readonly pageSize: number }): Promise<Page<StoreOrderSummary>> {
    const all = [...this.orders.values()]
      .filter((order) => scope.customerId === undefined || order.customerId === scope.customerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const start = (paging.page - 1) * paging.pageSize;
    return { items: all.slice(start, start + paging.pageSize).map((order) => this.summary(order)), page: paging.page, pageSize: paging.pageSize, total: all.length };
  }

  async getOrder(id: string, scope: OrderScope): Promise<StoreOrderDetail | null> {
    const order = this.orders.get(id);
    if (!order || (scope.customerId !== undefined && order.customerId !== scope.customerId)) return null;
    return {
      ...this.summary(order), customerId: order.customerId, recipientName: order.recipientName,
      recipientPhone: order.recipientPhone, notes: order.notes,
      items: order.lines.map((line) => ({ ...line, imageKey: this.products.get(line.productId)?.imageKey ?? null })),
    };
  }

  /** Para pruebas: suma de movimientos por producto, que debe coincidir con el stock actual. */
  ledgerBalance(productId: string): number {
    return this.ledger.filter((entry) => entry.productId === productId).reduce((total, entry) => total + entry.delta, 0);
  }
}

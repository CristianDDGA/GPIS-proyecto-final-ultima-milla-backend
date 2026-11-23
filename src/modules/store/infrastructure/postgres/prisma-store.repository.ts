import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
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
import { firstNameOf } from '../../domain/store.types.js';
import { isRetryableSqlError, mapStoreSqlError } from './store-sql-errors.js';

// Lecturas: SELECT parametrizado (el rol de la API solo tiene SELECT). Escrituras: solo funciones SECURITY DEFINER
// de la migración 010. Nada se concatena en el SQL: todo valor viaja como parámetro.

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly is_active: boolean;
  readonly version: bigint | number;
}

interface ProductRow {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly brand: string | null;
  readonly description: string | null;
  readonly category_id: string;
  readonly category_name: string;
  readonly price_cents: number;
  readonly compare_at_price_cents: number | null;
  readonly discount_percent: number | null;
  readonly stock_quantity: number;
  readonly image_key: string | null;
  readonly is_active: boolean;
  readonly version: bigint | number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface OrderRow {
  readonly id: string;
  readonly status: string;
  readonly zone_id: string;
  readonly customer_user_id: string;
  readonly delivery_address: string;
  readonly delivery_date: string;
  readonly delivery_time: string;
  readonly recipient_name: string | null;
  readonly recipient_phone: string | null;
  readonly notes: string | null;
  readonly total_cents: bigint | number;
  readonly items_count: number;
  readonly payment_method: string;
  readonly created_at: Date;
  readonly delivery_latitude: number | null;
  readonly delivery_longitude: number | null;
}

interface LineRow {
  readonly product_id: string;
  readonly sku: string;
  readonly product_name: string;
  readonly unit_price_cents: number;
  readonly quantity: number;
  readonly line_total_cents: bigint | number;
  readonly image_key: string | null;
}

const num = (value: bigint | number): number => Number(value);
const iso = (value: Date): string => value.toISOString();

function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, isActive: row.is_active, version: num(row.version) };
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    brand: row.brand,
    description: row.description,
    category: { id: row.category_id, name: row.category_name },
    priceCents: row.price_cents,
    compareAtPriceCents: row.compare_at_price_cents,
    discountPercent: row.discount_percent,
    stockQuantity: row.stock_quantity,
    imageKey: row.image_key,
    isActive: row.is_active,
    version: num(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toSummary(row: OrderRow): StoreOrderSummary {
  return {
    id: row.id,
    status: row.status,
    zoneId: row.zone_id,
    deliveryAddress: row.delivery_address,
    deliveryDate: row.delivery_date,
    deliveryTime: row.delivery_time,
    totalCents: num(row.total_cents),
    itemsCount: row.items_count,
    paymentMethod: row.payment_method,
    createdAt: iso(row.created_at),
    deliveryLatitude: row.delivery_latitude,
    deliveryLongitude: row.delivery_longitude,
  };
}

function toLine(row: LineRow): StoreOrderLine {
  return {
    productId: row.product_id,
    sku: row.sku,
    name: row.product_name,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    lineTotalCents: num(row.line_total_cents),
    imageKey: row.image_key,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Repite una operación idempotente ante interbloqueo o fallo de serialización, con espera corta y aleatoria. */
export async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      if (!isRetryableSqlError(error) || attempt === attempts) break;
      await sleep(20 + Math.floor(Math.random() * 60) * attempt);
    }
  }
  throw lastError;
}

export class PrismaStoreRepository implements CatalogRepository, StoreOrderRepository {
  constructor(private readonly prisma: PrismaDatabaseClient) {}

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      throw mapStoreSqlError(error);
    }
  }

  // --------------------------------------------------------------------------------------------- categorías

  listCategories(includeInactive: boolean): Promise<readonly Category[]> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<CategoryRow[]>`
        SELECT id, name, is_active, version FROM logistica.categories
        WHERE (${includeInactive}::boolean OR is_active)
        ORDER BY name_key, id`;
      return rows.map(toCategory);
    });
  }

  private async categoryById(id: string): Promise<Category> {
    const rows = await this.prisma.$queryRaw<CategoryRow[]>`
      SELECT id, name, is_active, version FROM logistica.categories WHERE id = ${id}::uuid`;
    const row = rows[0];
    if (row === undefined) throw new StoreError('CATEGORY_NOT_FOUND');
    return toCategory(row);
  }

  createCategory(name: string, actorId: string): Promise<Category> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT logistica.create_category(${name}::text, ${actorId}::uuid) AS id`;
      const id = rows[0]?.id;
      if (id === undefined) throw new StoreError('PERSISTENCE_UNAVAILABLE');
      return this.categoryById(id);
    });
  }

  updateCategory(id: string, patch: { name?: string; isActive?: boolean }, expectedVersion: number, actorId: string): Promise<Category> {
    return this.run(async () => {
      const name = patch.name ?? null;
      const isActive = patch.isActive ?? null;
      await this.prisma.$queryRaw`
        SELECT logistica.update_category(${id}::uuid, ${name}::text, ${isActive}::boolean, ${expectedVersion}::bigint, ${actorId}::uuid)`;
      return this.categoryById(id);
    });
  }

  // --------------------------------------------------------------------------------------------- productos

  listProducts(filter: ProductFilter): Promise<Page<Product>> {
    return this.run(async () => {
      const q = filter.q ?? null;
      const categoryId = filter.categoryId ?? null;
      const min = filter.minPriceCents ?? null;
      const max = filter.maxPriceCents ?? null;
      const offset = (filter.page - 1) * filter.pageSize;

      const rows = await this.prisma.$queryRaw<ProductRow[]>`
        WITH query AS (SELECT logistica.store_search_query(${q}::text) AS tsq)
        SELECT p.id, p.sku, p.name, p.brand, p.description, p.category_id, c.name AS category_name,
               p.price_cents, p.compare_at_price_cents,
               CASE WHEN p.compare_at_price_cents IS NOT NULL
                    THEN round(100.0 * (p.compare_at_price_cents - p.price_cents) / p.compare_at_price_cents)::integer END AS discount_percent,
               p.stock_quantity, p.image_key, p.is_active, p.version, p.created_at, p.updated_at
          FROM logistica.products p
          JOIN logistica.categories c ON c.id = p.category_id
          CROSS JOIN query
         WHERE (${filter.status}::text = 'all'
                OR (${filter.status}::text = 'active' AND p.is_active AND c.is_active)
                OR (${filter.status}::text = 'inactive' AND NOT (p.is_active AND c.is_active)))
           AND (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId}::uuid)
           AND (${min}::integer IS NULL OR p.price_cents >= ${min}::integer)
           AND (${max}::integer IS NULL OR p.price_cents <= ${max}::integer)
           AND (NOT ${filter.onSale}::boolean OR p.compare_at_price_cents IS NOT NULL)
           AND (query.tsq IS NULL OR p.search_vector @@ query.tsq OR c.search_vector @@ query.tsq)
         ORDER BY
           CASE WHEN ${filter.sort}::text = 'price_asc' THEN p.price_cents END ASC,
           CASE WHEN ${filter.sort}::text = 'price_desc' THEN p.price_cents END DESC,
           CASE WHEN ${filter.sort}::text = 'discount' THEN
             round(100.0 * (p.compare_at_price_cents - p.price_cents) / p.compare_at_price_cents) END DESC NULLS LAST,
           CASE WHEN ${filter.sort}::text = 'relevance' AND query.tsq IS NOT NULL THEN ts_rank(p.search_vector, query.tsq) END DESC NULLS LAST,
           p.created_at DESC, p.id
         LIMIT ${filter.pageSize}::integer OFFSET ${offset}::integer`;

      const counts = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
        WITH query AS (SELECT logistica.store_search_query(${q}::text) AS tsq)
        SELECT count(*) AS total
          FROM logistica.products p
          JOIN logistica.categories c ON c.id = p.category_id
          CROSS JOIN query
         WHERE (${filter.status}::text = 'all'
                OR (${filter.status}::text = 'active' AND p.is_active AND c.is_active)
                OR (${filter.status}::text = 'inactive' AND NOT (p.is_active AND c.is_active)))
           AND (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId}::uuid)
           AND (${min}::integer IS NULL OR p.price_cents >= ${min}::integer)
           AND (${max}::integer IS NULL OR p.price_cents <= ${max}::integer)
           AND (NOT ${filter.onSale}::boolean OR p.compare_at_price_cents IS NOT NULL)
           AND (query.tsq IS NULL OR p.search_vector @@ query.tsq OR c.search_vector @@ query.tsq)`;

      return { items: rows.map(toProduct), page: filter.page, pageSize: filter.pageSize, total: num(counts[0]?.total ?? 0) };
    });
  }

  getProduct(id: string, includeInactive: boolean): Promise<Product | null> {
    return this.run(() => this.productById(id, includeInactive));
  }

  private async productById(id: string, includeInactive: boolean): Promise<Product | null> {
    const rows = await this.prisma.$queryRaw<ProductRow[]>`
      SELECT p.id, p.sku, p.name, p.brand, p.description, p.category_id, c.name AS category_name,
             p.price_cents, p.compare_at_price_cents,
             CASE WHEN p.compare_at_price_cents IS NOT NULL
                  THEN round(100.0 * (p.compare_at_price_cents - p.price_cents) / p.compare_at_price_cents)::integer END AS discount_percent,
             p.stock_quantity, p.image_key, p.is_active, p.version, p.created_at, p.updated_at
        FROM logistica.products p
        JOIN logistica.categories c ON c.id = p.category_id
       WHERE p.id = ${id}::uuid AND (${includeInactive}::boolean OR (p.is_active AND c.is_active))`;
    const row = rows[0];
    return row === undefined ? null : toProduct(row);
  }

  createProduct(input: NewProduct, actorId: string): Promise<Product> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT logistica.create_product(
          ${input.sku}::text, ${input.name}::text, ${input.brand}::text, ${input.description}::text, ${input.categoryId}::uuid,
          ${input.priceCents}::integer, ${input.compareAtPriceCents}::integer, ${input.stock}::integer, ${input.imageKey}::text,
          ${input.isActive}::boolean, ${actorId}::uuid) AS id`;
      const id = rows[0]?.id;
      if (id === undefined) throw new StoreError('PERSISTENCE_UNAVAILABLE');
      const created = await this.productById(id, true);
      if (created === null) throw new StoreError('PERSISTENCE_UNAVAILABLE');
      return created;
    });
  }

  updateProduct(id: string, patch: ProductPatch, expectedVersion: number, actorId: string): Promise<Product> {
    return this.run(async () => {
      // Solo viajan los campos presentes; la función rechaza cualquier clave fuera de su lista blanca.
      const json: Record<string, unknown> = {};
      if (patch.name !== undefined) json['name'] = patch.name;
      if (patch.brand !== undefined) json['brand'] = patch.brand;
      if (patch.description !== undefined) json['description'] = patch.description;
      if (patch.categoryId !== undefined) json['categoryId'] = patch.categoryId;
      if (patch.priceCents !== undefined) json['priceCents'] = patch.priceCents;
      if (patch.compareAtPriceCents !== undefined) json['compareAtPriceCents'] = patch.compareAtPriceCents;
      if (patch.imageKey !== undefined) json['imageKey'] = patch.imageKey;
      if (patch.isActive !== undefined) json['isActive'] = patch.isActive;
      const payload = JSON.stringify(json);
      await this.prisma.$queryRaw`
        SELECT logistica.update_product(${id}::uuid, ${expectedVersion}::bigint, ${payload}::jsonb, ${actorId}::uuid)`;
      const updated = await this.productById(id, true);
      if (updated === null) throw new StoreError('PRODUCT_NOT_FOUND');
      return updated;
    });
  }

  adjustStock(id: string, delta: number, reason: StockReason, actorId: string): Promise<{ readonly id: string; readonly stock: number }> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<Array<{ result: { id: string; stock: number } }>>`
        SELECT logistica.adjust_stock(${id}::uuid, ${delta}::integer, ${reason}::text, ${actorId}::uuid) AS result`;
      const result = rows[0]?.result;
      if (result === undefined) throw new StoreError('PERSISTENCE_UNAVAILABLE');
      return { id: result.id, stock: Number(result.stock) };
    });
  }

  listProductEvents(id: string, limit: number): Promise<readonly ProductEvent[]> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<
        Array<{ id: string; action: string; actor_user_id: string | null; changes: Record<string, unknown>; created_at: Date }>
      >`
        SELECT id, action, actor_user_id, changes, created_at FROM logistica.product_events
         WHERE product_id = ${id}::uuid ORDER BY created_at DESC, id DESC LIMIT ${limit}::integer`;
      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorUserId: row.actor_user_id,
        changes: row.changes,
        createdAt: iso(row.created_at),
      }));
    });
  }

  // --------------------------------------------------------------------------------------------- configuración

  getSettings(): Promise<StoreSettings> {
    return this.run(() => this.readSettings());
  }

  private async readSettings(): Promise<StoreSettings> {
    const rows = await this.prisma.$queryRaw<
      Array<{ slot_capacity: number; first_slot_hour: number; last_slot_hour: number; min_lead_minutes: number }>
    >`SELECT slot_capacity, first_slot_hour, last_slot_hour, min_lead_minutes FROM logistica.store_settings`;
    const row = rows[0];
    if (row === undefined) throw new StoreError('PERSISTENCE_UNAVAILABLE');
    return { slotCapacity: row.slot_capacity, firstSlotHour: row.first_slot_hour, lastSlotHour: row.last_slot_hour, minLeadMinutes: row.min_lead_minutes };
  }

  updateSettings(settings: StoreSettings, actorId: string): Promise<StoreSettings> {
    return this.run(async () => {
      await this.prisma.$queryRaw`
        SELECT logistica.set_store_settings(${settings.slotCapacity}::integer, ${settings.firstSlotHour}::integer,
                                            ${settings.lastSlotHour}::integer, ${settings.minLeadMinutes}::integer, ${actorId}::uuid)`;
      return this.readSettings();
    });
  }

  // --------------------------------------------------------------------------------------------- pedidos

  deliverySlots(zoneId: string, date: string): Promise<readonly DeliverySlot[] | null> {
    return this.run(async () => {
      const zones = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM logistica.zones WHERE id = ${zoneId}::uuid AND is_active`;
      if (zones.length === 0) return null;
      const rows = await this.prisma.$queryRaw<Array<{ slot_time: string; capacity: number; reserved: number; available: boolean }>>`
        SELECT to_char(slot_time, 'HH24:MI') AS slot_time, capacity, reserved, available
          FROM logistica.delivery_slots(${zoneId}::uuid, ${date}::date)`;
      return rows.map((row) => ({ time: row.slot_time, capacity: row.capacity, reserved: row.reserved, available: row.available }));
    });
  }

  placeOrder(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    return this.run(() =>
      withRetry(async () => {
        const items = JSON.stringify(
          command.items.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPriceCents: item.unitPriceCents })),
        );
        const rows = await this.prisma.$queryRaw<Array<{ result: unknown }>>`
          SELECT logistica.place_store_order(
            ${command.customerId}::uuid, ${command.zoneId}::uuid, ${command.deliveryAddress}::text,
            ${command.deliveryDate}::date, ${command.deliveryTime}::time,
            ${command.recipientName}::text, ${command.recipientPhone}::text, ${command.notes}::text,
            ${items}::jsonb, ${command.idempotencyKey}::uuid,
            ${command.latitude}::double precision, ${command.longitude}::double precision) AS result`;
        return parsePlaceResult(rows[0]?.result);
      }),
    );
  }

  listOrders(scope: OrderScope, paging: { readonly page: number; readonly pageSize: number }): Promise<Page<StoreOrderSummary>> {
    return this.run(async () => {
      const customerId = scope.customerId ?? null;
      const offset = (paging.page - 1) * paging.pageSize;
      const rows = await this.prisma.$queryRaw<OrderRow[]>`
        SELECT o.id, o.status, o.zone_id, s.customer_user_id, o.delivery_address,
               to_char(o.delivery_date, 'YYYY-MM-DD') AS delivery_date, left(o.delivery_time::text, 5) AS delivery_time,
               o.recipient_name, o.recipient_phone, o.notes, s.total_cents, s.items_count, s.payment_method, s.created_at,
               s.delivery_latitude, s.delivery_longitude
          FROM logistica.store_orders s JOIN logistica.orders o ON o.id = s.order_id
         WHERE (${customerId}::uuid IS NULL OR s.customer_user_id = ${customerId}::uuid)
         ORDER BY s.created_at DESC, o.id DESC
         LIMIT ${paging.pageSize}::integer OFFSET ${offset}::integer`;
      const counts = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
        SELECT count(*) AS total FROM logistica.store_orders s
         WHERE (${customerId}::uuid IS NULL OR s.customer_user_id = ${customerId}::uuid)`;
      return { items: rows.map(toSummary), page: paging.page, pageSize: paging.pageSize, total: num(counts[0]?.total ?? 0) };
    });
  }

  getOrder(id: string, scope: OrderScope): Promise<StoreOrderDetail | null> {
    return this.run(async () => {
      const customerId = scope.customerId ?? null;
      const rows = await this.prisma.$queryRaw<OrderRow[]>`
        SELECT o.id, o.status, o.zone_id, s.customer_user_id, o.delivery_address,
               to_char(o.delivery_date, 'YYYY-MM-DD') AS delivery_date, left(o.delivery_time::text, 5) AS delivery_time,
               o.recipient_name, o.recipient_phone, o.notes, s.total_cents, s.items_count, s.payment_method, s.created_at,
               s.delivery_latitude, s.delivery_longitude
          FROM logistica.store_orders s JOIN logistica.orders o ON o.id = s.order_id
         WHERE o.id = ${id}::uuid AND (${customerId}::uuid IS NULL OR s.customer_user_id = ${customerId}::uuid)`;
      const row = rows[0];
      if (row === undefined) return null;
      const lines = await this.prisma.$queryRaw<LineRow[]>`
        SELECT i.product_id, i.sku, i.product_name, i.unit_price_cents, i.quantity, i.line_total_cents, p.image_key
          FROM logistica.order_items i LEFT JOIN logistica.products p ON p.id = i.product_id
         WHERE i.order_id = ${id}::uuid
         ORDER BY i.product_name, i.product_id`;
      // Línea de tiempo: solo la creación y los cambios de estado (no las ediciones de datos), en orden.
      const events = await this.prisma.$queryRaw<Array<{ to_status: string; occurred_at: Date }>>`
        SELECT to_status, occurred_at FROM logistica.order_events
         WHERE order_id = ${id}::uuid AND event_type IN ('creado', 'estado_cambiado')
         ORDER BY order_version`;
      // Repartidor de la ruta vigente (asignada o en curso) que tiene la parada del pedido.
      const couriers = await this.prisma.$queryRaw<Array<{ display_name: string }>>`
        SELECT c.display_name
          FROM logistica.route_stops s
          JOIN logistica.routes r ON r.id = s.route_id
          JOIN logistica.couriers c ON c.id = r.courier_id
         WHERE s.order_id = ${id}::uuid AND s.released_at IS NULL AND r.status IN ('asignada', 'en_curso')
         LIMIT 1`;
      const firstName = firstNameOf(couriers[0]?.display_name);
      return {
        ...toSummary(row),
        customerId: row.customer_user_id,
        recipientName: row.recipient_name,
        recipientPhone: row.recipient_phone,
        notes: row.notes,
        items: lines.map(toLine),
        history: events.map((event) => ({ status: event.to_status, at: new Date(event.occurred_at).toISOString() })),
        courier: firstName === null ? null : { firstName },
      };
    });
  }
}

const CONFLICT_REASONS = new Set(['unavailable', 'price_changed', 'insufficient_stock', 'slot_invalid', 'slot_unavailable', 'slot_full', 'zone_inactive']);

function parsePlaceResult(value: unknown): PlaceOrderResult {
  if (value === null || typeof value !== 'object') throw new StoreError('PERSISTENCE_UNAVAILABLE');
  const result = value as Record<string, unknown>;
  const replayed = result['replayed'] === true;
  if (result['status'] === 'ok' && typeof result['orderId'] === 'string') {
    return { status: 'ok', orderId: result['orderId'], totalCents: Number(result['totalCents']), itemsCount: Number(result['itemsCount']), replayed };
  }
  if (result['status'] === 'conflict' && Array.isArray(result['conflicts'])) {
    const conflicts: OrderConflict[] = [];
    for (const raw of result['conflicts'] as unknown[]) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const reason = entry['reason'];
      if (typeof reason !== 'string' || !CONFLICT_REASONS.has(reason)) continue;
      conflicts.push({
        reason: reason as OrderConflict['reason'],
        ...(typeof entry['productId'] === 'string' ? { productId: entry['productId'] } : {}),
        ...(typeof entry['currentPriceCents'] === 'number' ? { currentPriceCents: entry['currentPriceCents'] } : {}),
        ...(typeof entry['available'] === 'number' ? { available: entry['available'] } : {}),
        ...(typeof entry['capacity'] === 'number' ? { capacity: entry['capacity'] } : {}),
      });
    }
    return { status: 'conflict', conflicts, replayed };
  }
  throw new StoreError('PERSISTENCE_UNAVAILABLE');
}

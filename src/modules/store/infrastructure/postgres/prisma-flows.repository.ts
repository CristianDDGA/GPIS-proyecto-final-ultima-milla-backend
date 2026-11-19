import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { FlowsRepository } from '../../application/ports/flows.ports.js';
import { StoreError } from '../../domain/store.errors.js';
import type {
  Address,
  AddressPatch,
  AdminCashRow,
  AdminOrderFilter,
  CancelResult,
  CourierCash,
  CourierOrder,
  DeliveryOutcome,
  FlowActor,
  LowStockItem,
  NewAddress,
  NotificationKind,
  NotificationOutcome,
  PendingNotification,
  RescheduleResult,
  SalesSummary,
  SettlementResult,
} from '../../domain/flows.types.js';
import type { Page, StoreOrderDetail, StoreOrderLine } from '../../domain/store.types.js';
import { withRetry } from './prisma-store.repository.js';
import { mapStoreSqlError } from './store-sql-errors.js';

// Lecturas con SELECT parametrizado; escrituras solo con las funciones SECURITY DEFINER de la migración 011.

const num = (value: bigint | number | null | undefined): number => Number(value ?? 0);
const iso = (value: Date): string => value.toISOString();

interface AddressRow {
  readonly id: string; readonly label: string; readonly zone_id: string; readonly address: string;
  readonly recipient_name: string | null; readonly recipient_phone: string | null; readonly is_default: boolean; readonly version: bigint | number;
}

const toAddress = (row: AddressRow): Address => ({
  id: row.id, label: row.label, zoneId: row.zone_id, address: row.address, recipientName: row.recipient_name,
  recipientPhone: row.recipient_phone, isDefault: row.is_default, version: num(row.version),
});

interface OrderHeadRow {
  readonly id: string; readonly status: string; readonly zone_id: string; readonly customer_user_id: string; readonly delivery_address: string;
  readonly delivery_date: string; readonly delivery_time: string; readonly recipient_name: string | null; readonly recipient_phone: string | null;
  readonly notes: string | null; readonly total_cents: bigint | number; readonly items_count: number; readonly payment_method: string; readonly created_at: Date;
}

interface LineRow {
  readonly order_id: string; readonly product_id: string; readonly sku: string; readonly product_name: string; readonly unit_price_cents: number;
  readonly quantity: number; readonly line_total_cents: bigint | number; readonly image_key: string | null;
}

export class PrismaFlowsRepository implements FlowsRepository {
  constructor(private readonly prisma: PrismaDatabaseClient) {}

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      throw mapStoreSqlError(error);
    }
  }

  private async fn<T>(query: Promise<Array<{ result: T }>>): Promise<T> {
    const result = (await query)[0]?.result;
    if (result === undefined || result === null) throw new StoreError('PERSISTENCE_UNAVAILABLE');
    return result;
  }

  // --------------------------------------------------------------------------------------------- cancelar y reprogramar

  cancelOrder(input: { orderId: string; actor: FlowActor; reason: string; note: string | null }): Promise<CancelResult> {
    return this.run(() => withRetry(async () => {
      const r = await this.fn<{ status: 'cancelado'; alreadyCancelled: boolean; restocked?: boolean; version: number }>(this.prisma.$queryRaw`
        SELECT logistica.cancel_order(${input.orderId}::uuid, ${input.actor.id}::uuid, ${input.reason}::text, ${input.note}::text) AS result`);
      return { status: 'cancelado', alreadyCancelled: r.alreadyCancelled, restocked: r.restocked === true, version: Number(r.version) };
    }));
  }

  rescheduleOrder(input: { orderId: string; actor: FlowActor; deliveryDate: string; deliveryTime: string }): Promise<RescheduleResult> {
    return this.run(async () => {
      const r = await this.fn<{ status: string; reason?: string; orderId?: string; orderStatus?: string; version?: number }>(this.prisma.$queryRaw`
        SELECT logistica.reschedule_order(${input.orderId}::uuid, ${input.deliveryDate}::date, ${input.deliveryTime}::time, ${input.actor.id}::uuid) AS result`);
      if (r.status === 'conflict') return { status: 'conflict', reason: r.reason as 'slot_invalid' | 'slot_unavailable' | 'slot_full' };
      return { status: 'ok', orderId: String(r.orderId), orderStatus: 'pendiente', version: Number(r.version) };
    });
  }

  // --------------------------------------------------------------------------------------------- conductor

  courierOrders(courierUserId: string): Promise<readonly CourierOrder[]> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<Array<{
        order_id: string; version: bigint | number; status: string; route_id: string; route_status: string; position: bigint | number;
        delivery_address: string; delivery_date: string; delivery_time: string; recipient_name: string | null; recipient_phone: string | null;
        notes: string | null; is_store_order: boolean; total_cents: bigint | number | null; failed_attempts: number;
        items: Array<{ name: string; quantity: number; unitPriceCents: number; lineTotalCents: number | string }>;
      }>>`
        SELECT o.id AS order_id, o.version, o.status, r.id AS route_id, r.status AS route_status, s.position,
               o.delivery_address, to_char(o.delivery_date, 'YYYY-MM-DD') AS delivery_date, left(o.delivery_time::text, 5) AS delivery_time,
               o.recipient_name, o.recipient_phone, o.notes, (so.order_id IS NOT NULL) AS is_store_order, so.total_cents,
               (SELECT count(*) FROM logistica.delivery_failures f WHERE f.order_id = o.id)::integer AS failed_attempts,
               coalesce((SELECT json_agg(json_build_object('name', i.product_name, 'quantity', i.quantity,
                                                           'unitPriceCents', i.unit_price_cents, 'lineTotalCents', i.line_total_cents)
                                         ORDER BY i.product_name, i.product_id)
                           FROM logistica.order_items i WHERE i.order_id = o.id), '[]'::json) AS items
          FROM logistica.route_stops s
          JOIN logistica.routes r ON r.id = s.route_id
          JOIN logistica.couriers c ON c.id = r.courier_id
          JOIN logistica.orders o ON o.id = s.order_id
          LEFT JOIN logistica.store_orders so ON so.order_id = o.id
         WHERE c.user_id = ${courierUserId}::uuid AND s.released_at IS NULL AND r.status IN ('asignada', 'en_curso')
         ORDER BY r.service_date, r.id, s.position`;
      return rows.map((row) => ({
        orderId: row.order_id, version: num(row.version), status: row.status, routeId: row.route_id, routeStatus: row.route_status,
        position: num(row.position), deliveryAddress: row.delivery_address, deliveryDate: row.delivery_date, deliveryTime: row.delivery_time,
        recipientName: row.recipient_name, recipientPhone: row.recipient_phone, notes: row.notes, isStoreOrder: row.is_store_order,
        totalCents: row.total_cents === null ? null : num(row.total_cents), failedAttempts: row.failed_attempts,
        items: row.items.map((item) => ({ name: item.name, quantity: item.quantity, unitPriceCents: item.unitPriceCents, lineTotalCents: Number(item.lineTotalCents) })),
      }));
    });
  }

  deliverOrder(input: { orderId: string; courierUserId: string; expectedVersion: number; collectedCents: number; idempotencyKey: string }): Promise<DeliveryOutcome> {
    return this.run(() => withRetry(async () => {
      const r = await this.fn<{ orderId: string; status: 'entregado'; version: number; collectedCents: number; replayed: boolean }>(this.prisma.$queryRaw`
        SELECT logistica.deliver_store_order(${input.orderId}::uuid, ${input.expectedVersion}::bigint, ${input.courierUserId}::uuid,
                                             ${input.collectedCents}::bigint, ${input.idempotencyKey}::uuid) AS result`);
      return { orderId: r.orderId, status: 'entregado', version: Number(r.version), collectedCents: Number(r.collectedCents), replayed: r.replayed === true };
    }, 2));
  }

  failDelivery(input: { orderId: string; courierUserId: string; expectedVersion: number; reason: string; note: string | null; idempotencyKey: string }): Promise<DeliveryOutcome> {
    return this.run(() => withRetry(async () => {
      const r = await this.fn<{ orderId: string; status: 'entrega_fallida'; version: number; attempt: number; replayed: boolean }>(this.prisma.$queryRaw`
        SELECT logistica.fail_delivery(${input.orderId}::uuid, ${input.expectedVersion}::bigint, ${input.courierUserId}::uuid,
                                       ${input.reason}::text, ${input.note}::text, ${input.idempotencyKey}::uuid) AS result`);
      return { orderId: r.orderId, status: 'entrega_fallida', version: Number(r.version), attempt: Number(r.attempt), replayed: r.replayed === true };
    }, 2));
  }

  // --------------------------------------------------------------------------------------------- caja

  courierCash(courierUserId: string, date: string): Promise<CourierCash> {
    return this.run(async () => {
      const totals = await this.prisma.$queryRaw<Array<{ collected: bigint | number; n: number }>>`
        SELECT coalesce(sum(amount_cents), 0)::bigint AS collected, count(*)::integer AS n FROM logistica.order_collections
         WHERE courier_user_id = ${courierUserId}::uuid AND (collected_at AT TIME ZONE 'America/Guayaquil')::date = ${date}::date`;
      const settlement = await this.prisma.$queryRaw<Array<{ expected_cents: bigint | number; received_cents: bigint | number; settled_at: Date }>>`
        SELECT expected_cents, received_cents, settled_at FROM logistica.cash_settlements
         WHERE courier_user_id = ${courierUserId}::uuid AND service_date = ${date}::date`;
      const s = settlement[0];
      return {
        date, collectedCents: num(totals[0]?.collected), ordersCount: totals[0]?.n ?? 0,
        settlement: s ? { receivedCents: num(s.received_cents), differenceCents: num(s.received_cents) - num(s.expected_cents), settledAt: iso(s.settled_at) } : null,
      };
    });
  }

  adminCash(date: string): Promise<readonly AdminCashRow[]> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<Array<{
        courier_user_id: string; courier_name: string | null; collected: bigint | number; n: number;
        expected_cents: bigint | number | null; received_cents: bigint | number | null; settled_at: Date | null;
      }>>`
        SELECT c.courier_user_id, u.display_name AS courier_name, sum(c.amount_cents)::bigint AS collected, count(*)::integer AS n,
               st.expected_cents, st.received_cents, st.settled_at
          FROM logistica.order_collections c
          JOIN logistica.app_users u ON u.id = c.courier_user_id
          LEFT JOIN logistica.cash_settlements st ON st.courier_user_id = c.courier_user_id AND st.service_date = ${date}::date
         WHERE (c.collected_at AT TIME ZONE 'America/Guayaquil')::date = ${date}::date
         GROUP BY c.courier_user_id, u.display_name, st.expected_cents, st.received_cents, st.settled_at
         ORDER BY u.display_name NULLS LAST, c.courier_user_id`;
      return rows.map((row) => ({
        date, courierUserId: row.courier_user_id, courierName: row.courier_name, collectedCents: num(row.collected), ordersCount: row.n,
        settlement: row.received_cents === null || row.expected_cents === null || row.settled_at === null
          ? null
          : { receivedCents: num(row.received_cents), differenceCents: num(row.received_cents) - num(row.expected_cents), settledAt: iso(row.settled_at) },
      }));
    });
  }

  settleCash(input: { courierUserId: string; date: string; receivedCents: number; note: string | null; actorId: string }): Promise<SettlementResult> {
    return this.run(async () => {
      const r = await this.fn<{ expectedCents: number; receivedCents: number; differenceCents: number }>(this.prisma.$queryRaw`
        SELECT logistica.settle_cash(${input.courierUserId}::uuid, ${input.date}::date, ${input.receivedCents}::bigint, ${input.note}::text, ${input.actorId}::uuid) AS result`);
      return { expectedCents: Number(r.expectedCents), receivedCents: Number(r.receivedCents), differenceCents: Number(r.differenceCents) };
    });
  }

  // --------------------------------------------------------------------------------------------- direcciones

  private async addressById(userId: string, id: string): Promise<Address> {
    const rows = await this.prisma.$queryRaw<AddressRow[]>`
      SELECT id, label, zone_id, address, recipient_name, recipient_phone, is_default, version
        FROM logistica.customer_addresses WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`;
    const row = rows[0];
    if (row === undefined) throw new StoreError('ADDRESS_NOT_FOUND');
    return toAddress(row);
  }

  listAddresses(userId: string): Promise<readonly Address[]> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<AddressRow[]>`
        SELECT id, label, zone_id, address, recipient_name, recipient_phone, is_default, version
          FROM logistica.customer_addresses WHERE user_id = ${userId}::uuid ORDER BY is_default DESC, label_key, id`;
      return rows.map(toAddress);
    });
  }

  createAddress(userId: string, input: NewAddress): Promise<Address> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT logistica.create_address(${userId}::uuid, ${input.label}::text, ${input.zoneId}::uuid, ${input.address}::text,
                                        ${input.recipientName}::text, ${input.recipientPhone}::text, ${input.isDefault}::boolean) AS id`;
      const id = rows[0]?.id;
      if (id === undefined) throw new StoreError('PERSISTENCE_UNAVAILABLE');
      return this.addressById(userId, id);
    });
  }

  updateAddress(userId: string, id: string, patch: AddressPatch, expectedVersion: number): Promise<Address> {
    return this.run(async () => {
      const json: Record<string, unknown> = {};
      if (patch.label !== undefined) json['label'] = patch.label;
      if (patch.zoneId !== undefined) json['zoneId'] = patch.zoneId;
      if (patch.address !== undefined) json['address'] = patch.address;
      if (patch.recipientName !== undefined) json['recipientName'] = patch.recipientName;
      if (patch.recipientPhone !== undefined) json['recipientPhone'] = patch.recipientPhone;
      if (patch.isDefault !== undefined) json['isDefault'] = patch.isDefault;
      const payload = JSON.stringify(json);
      await this.prisma.$queryRaw`SELECT logistica.update_address(${id}::uuid, ${userId}::uuid, ${payload}::jsonb, ${expectedVersion}::bigint)`;
      return this.addressById(userId, id);
    });
  }

  async deleteAddress(userId: string, id: string): Promise<void> {
    await this.run(async () => { await this.prisma.$queryRaw`SELECT logistica.delete_address(${id}::uuid, ${userId}::uuid)`; });
  }

  // --------------------------------------------------------------------------------------------- despacho y reportes

  listOrderDetails(filter: AdminOrderFilter, paging: { readonly page: number; readonly pageSize: number }): Promise<Page<StoreOrderDetail>> {
    return this.run(async () => {
      const status = filter.status ?? null;
      const date = filter.deliveryDate ?? null;
      const zone = filter.zoneId ?? null;
      const offset = (paging.page - 1) * paging.pageSize;
      const heads = await this.prisma.$queryRaw<OrderHeadRow[]>`
        SELECT o.id, o.status, o.zone_id, s.customer_user_id, o.delivery_address,
               to_char(o.delivery_date, 'YYYY-MM-DD') AS delivery_date, left(o.delivery_time::text, 5) AS delivery_time,
               o.recipient_name, o.recipient_phone, o.notes, s.total_cents, s.items_count, s.payment_method, s.created_at
          FROM logistica.store_orders s JOIN logistica.orders o ON o.id = s.order_id
         WHERE (${status}::text IS NULL OR o.status = ${status}::text)
           AND (${date}::date IS NULL OR o.delivery_date = ${date}::date)
           AND (${zone}::uuid IS NULL OR o.zone_id = ${zone}::uuid)
         ORDER BY o.delivery_date, o.delivery_time, s.created_at, o.id
         LIMIT ${paging.pageSize}::integer OFFSET ${offset}::integer`;
      const counts = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
        SELECT count(*) AS total FROM logistica.store_orders s JOIN logistica.orders o ON o.id = s.order_id
         WHERE (${status}::text IS NULL OR o.status = ${status}::text)
           AND (${date}::date IS NULL OR o.delivery_date = ${date}::date)
           AND (${zone}::uuid IS NULL OR o.zone_id = ${zone}::uuid)`;
      const ids = heads.map((row) => row.id);
      const lines = ids.length === 0 ? [] : await this.prisma.$queryRaw<LineRow[]>`
        SELECT i.order_id, i.product_id, i.sku, i.product_name, i.unit_price_cents, i.quantity, i.line_total_cents, p.image_key
          FROM logistica.order_items i LEFT JOIN logistica.products p ON p.id = i.product_id
         WHERE i.order_id = ANY (${ids}::uuid[]) ORDER BY i.product_name, i.product_id`;
      const byOrder = new Map<string, StoreOrderLine[]>();
      for (const line of lines) {
        const list = byOrder.get(line.order_id) ?? [];
        list.push({
          productId: line.product_id, sku: line.sku, name: line.product_name, unitPriceCents: line.unit_price_cents,
          quantity: line.quantity, lineTotalCents: num(line.line_total_cents), imageKey: line.image_key,
        });
        byOrder.set(line.order_id, list);
      }
      return {
        items: heads.map((row) => ({
          id: row.id, status: row.status, zoneId: row.zone_id, deliveryAddress: row.delivery_address, deliveryDate: row.delivery_date,
          deliveryTime: row.delivery_time, totalCents: num(row.total_cents), itemsCount: row.items_count, paymentMethod: row.payment_method,
          createdAt: iso(row.created_at), customerId: row.customer_user_id, recipientName: row.recipient_name, recipientPhone: row.recipient_phone,
          notes: row.notes, items: byOrder.get(row.id) ?? [],
        })),
        page: paging.page, pageSize: paging.pageSize, total: num(counts[0]?.total),
      };
    });
  }

  lowStock(threshold: number, limit: number): Promise<readonly LowStockItem[]> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; sku: string; name: string; stock_quantity: number; is_active: boolean }>>`
        SELECT id, sku, name, stock_quantity, is_active FROM logistica.products
         WHERE stock_quantity <= ${threshold}::integer ORDER BY stock_quantity, name, id LIMIT ${limit}::integer`;
      return rows.map((row) => ({ id: row.id, sku: row.sku, name: row.name, stockQuantity: row.stock_quantity, isActive: row.is_active }));
    });
  }

  summary(from: string, to: string): Promise<SalesSummary> {
    return this.run(async () => {
      const byStatus = await this.prisma.$queryRaw<Array<{ status: string; n: number }>>`
        SELECT o.status, count(*)::integer AS n FROM logistica.store_orders s JOIN logistica.orders o ON o.id = s.order_id
         WHERE o.delivery_date BETWEEN ${from}::date AND ${to}::date GROUP BY o.status`;
      const gross = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
        SELECT coalesce(sum(s.total_cents), 0)::bigint AS total FROM logistica.store_orders s JOIN logistica.orders o ON o.id = s.order_id
         WHERE o.delivery_date BETWEEN ${from}::date AND ${to}::date AND o.status <> 'cancelado'`;
      const collected = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>`
        SELECT coalesce(sum(amount_cents), 0)::bigint AS total FROM logistica.order_collections
         WHERE (collected_at AT TIME ZONE 'America/Guayaquil')::date BETWEEN ${from}::date AND ${to}::date`;
      const cancels = await this.prisma.$queryRaw<Array<{ reason: string; n: number }>>`
        SELECT c.reason, count(*)::integer AS n FROM logistica.order_cancellations c JOIN logistica.orders o ON o.id = c.order_id
         WHERE o.delivery_date BETWEEN ${from}::date AND ${to}::date GROUP BY c.reason`;
      const fails = await this.prisma.$queryRaw<Array<{ reason: string; n: number }>>`
        SELECT reason, count(*)::integer AS n FROM logistica.delivery_failures
         WHERE (created_at AT TIME ZONE 'America/Guayaquil')::date BETWEEN ${from}::date AND ${to}::date GROUP BY reason`;
      const top = await this.prisma.$queryRaw<Array<{ product_id: string; name: string; units: bigint | number; revenue: bigint | number }>>`
        SELECT i.product_id, max(i.product_name) AS name, sum(i.quantity)::bigint AS units, sum(i.line_total_cents)::bigint AS revenue
          FROM logistica.order_items i JOIN logistica.orders o ON o.id = i.order_id
         WHERE o.delivery_date BETWEEN ${from}::date AND ${to}::date AND o.status <> 'cancelado'
         GROUP BY i.product_id ORDER BY units DESC, revenue DESC, i.product_id LIMIT 5`;
      const low = await this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::integer AS n FROM logistica.products WHERE is_active AND stock_quantity <= 5`;
      const toMap = (rows: Array<{ n: number } & Record<string, unknown>>, key: string): Record<string, number> =>
        Object.fromEntries(rows.map((row) => [String(row[key]), row.n]));
      return {
        from, to,
        orders: { total: byStatus.reduce((total, row) => total + row.n, 0), byStatus: toMap(byStatus, 'status') },
        grossCents: num(gross[0]?.total), collectedCents: num(collected[0]?.total),
        cancellations: { count: cancels.reduce((total, row) => total + row.n, 0), byReason: toMap(cancels, 'reason') },
        failures: { count: fails.reduce((total, row) => total + row.n, 0), byReason: toMap(fails, 'reason') },
        topProducts: top.map((row) => ({ productId: row.product_id, name: row.name, units: num(row.units), revenueCents: num(row.revenue) })),
        lowStockCount: low[0]?.n ?? 0,
      };
    });
  }

  // --------------------------------------------------------------------------------------------- avisos por correo

  claimNotifications(limit: number): Promise<readonly PendingNotification[]> {
    return this.run(async () => {
      const rows = await this.prisma.$queryRaw<Array<{
        id: string; order_id: string; kind: string; status_to: string | null; attempts: number;
        email: string | null; display_name: string | null; email_verified_via: string | null;
      }>>`SELECT id, order_id, kind, status_to, attempts, email, display_name, email_verified_via FROM logistica.claim_notifications(${limit}::integer)`;
      return rows.map((row) => ({
        id: row.id, orderId: row.order_id, kind: row.kind as NotificationKind, statusTo: row.status_to, attempts: row.attempts,
        email: row.email, displayName: row.display_name, emailVerifiedVia: row.email_verified_via,
      }));
    });
  }

  async finishNotification(id: string, outcome: NotificationOutcome): Promise<void> {
    await this.run(async () => { await this.prisma.$queryRaw`SELECT logistica.finish_notification(${id}::uuid, ${outcome}::text)`; });
  }
}

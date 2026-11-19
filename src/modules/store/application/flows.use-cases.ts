import { StoreError } from '../domain/store.errors.js';
import {
  bodyObject,
  parsePaging,
  validateUuid,
} from '../domain/store.validation.js';
import {
  parseAddressPatch,
  parseAdminOrderFilter,
  parseCancel,
  parseDateQuery,
  parseDeliver,
  parseFail,
  parseNewAddress,
  parseRangeQuery,
  parseReschedule,
  parseSettle,
  parseThreshold,
} from '../domain/flows.validation.js';
import type { FlowActor } from '../domain/flows.types.js';
import type { StoreOrderDetail } from '../domain/store.types.js';
import type { FlowsRepository } from './ports/flows.ports.js';
import type { ProductImageStorage, StoreOrderRepository } from './ports/store.ports.js';

/** Fecha de hoy en Ecuador (UTC-5 todo el año). */
export function todayInEcuador(now: Date = new Date()): string {
  return new Date(now.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

const SCHEDULE_MESSAGES = {
  slot_invalid: 'La franja elegida no es válida: usa una hora en punto dentro del horario de la tienda.',
  slot_unavailable: 'La franja elegida ya no está disponible. Elige otra.',
  slot_full: 'La franja elegida se llenó. Elige otra.',
} as const;

/** Casos de uso de los flujos por rol. Aquí se decide quién puede hacer qué; la base de datos lo vuelve a comprobar. */
export class StoreFlowsUseCases {
  constructor(
    private readonly flows: FlowsRepository,
    private readonly orders: StoreOrderRepository,
    private readonly images: ProductImageStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private static role(actor: FlowActor, ...allowed: Array<FlowActor['role']>): void {
    if (!allowed.includes(actor.role)) throw new StoreError('FORBIDDEN');
  }

  private withImageUrls(order: StoreOrderDetail) {
    return {
      ...order,
      items: order.items.map(({ imageKey, ...line }) => ({
        ...line,
        imageUrl: imageKey === null ? null : (this.images.publicUrl(imageKey) ?? `/store/images/${imageKey}`),
      })),
    };
  }

  // -------------------------------------------------------------------------------------- cancelar y reprogramar

  /** Cliente dueño o administrador. Si el pedido ya estaba cancelado devuelve lo mismo (idempotente). */
  async cancelOrder(actor: FlowActor, id: unknown, body: unknown) {
    StoreFlowsUseCases.role(actor, 'cliente', 'personal');
    const orderId = validateUuid(id, 'El pedido');
    const { reason, note } = parseCancel(bodyObject(body));
    const result = await this.flows.cancelOrder({ orderId, actor, reason, note });
    const order = await this.orders.getOrder(orderId, {});
    return { ...result, order: order === null ? null : this.withImageUrls(order) };
  }

  async rescheduleOrder(actor: FlowActor, id: unknown, body: unknown) {
    StoreFlowsUseCases.role(actor, 'cliente', 'personal');
    const orderId = validateUuid(id, 'El pedido');
    const { deliveryDate, deliveryTime } = parseReschedule(bodyObject(body));
    const result = await this.flows.rescheduleOrder({ orderId, actor, deliveryDate, deliveryTime });
    if (result.status === 'conflict') throw new StoreError('SCHEDULE_CONFLICT', SCHEDULE_MESSAGES[result.reason], { reason: result.reason });
    const order = await this.orders.getOrder(orderId, {});
    return order === null ? { orderId } : this.withImageUrls(order);
  }

  // -------------------------------------------------------------------------------------- conductor

  async courierOrders(actor: FlowActor) {
    StoreFlowsUseCases.role(actor, 'repartidor');
    return { items: await this.flows.courierOrders(actor.id) };
  }

  async deliverOrder(actor: FlowActor, id: unknown, body: unknown, key: unknown) {
    StoreFlowsUseCases.role(actor, 'repartidor');
    const orderId = validateUuid(id, 'El pedido');
    const { expectedVersion, collectedCents, idempotencyKey } = parseDeliver(bodyObject(body), key);
    return this.flows.deliverOrder({ orderId, courierUserId: actor.id, expectedVersion, collectedCents, idempotencyKey });
  }

  async failDelivery(actor: FlowActor, id: unknown, body: unknown, key: unknown) {
    StoreFlowsUseCases.role(actor, 'repartidor');
    const orderId = validateUuid(id, 'El pedido');
    const { expectedVersion, reason, note, idempotencyKey } = parseFail(bodyObject(body), key);
    return this.flows.failDelivery({ orderId, courierUserId: actor.id, expectedVersion, reason, note, idempotencyKey });
  }

  async courierCash(actor: FlowActor, query: Record<string, unknown>) {
    StoreFlowsUseCases.role(actor, 'repartidor');
    return this.flows.courierCash(actor.id, parseDateQuery(query, todayInEcuador(this.now())));
  }

  // -------------------------------------------------------------------------------------- administrador

  async adminCash(actor: FlowActor, query: Record<string, unknown>) {
    StoreFlowsUseCases.role(actor, 'personal');
    const date = parseDateQuery(query, todayInEcuador(this.now()));
    return { date, items: await this.flows.adminCash(date) };
  }

  async settleCash(actor: FlowActor, body: unknown) {
    StoreFlowsUseCases.role(actor, 'personal');
    const { courierUserId, date, receivedCents, note } = parseSettle(bodyObject(body));
    return this.flows.settleCash({ courierUserId, date, receivedCents, note, actorId: actor.id });
  }

  /** Despacho: pedidos de tienda con filtros; con expand=items trae las líneas de cada pedido. */
  async adminOrders(actor: FlowActor, query: Record<string, unknown>) {
    StoreFlowsUseCases.role(actor, 'personal');
    const { expand, ...filter } = parseAdminOrderFilter(query);
    const page = await this.flows.listOrderDetails(filter, parsePaging(query, 20));
    return {
      ...page,
      items: page.items.map((order) => (expand ? this.withImageUrls(order) : { ...order, items: undefined })),
    };
  }

  async lowStock(actor: FlowActor, query: Record<string, unknown>) {
    StoreFlowsUseCases.role(actor, 'personal');
    const { threshold, limit } = parseThreshold(query);
    return { threshold, items: await this.flows.lowStock(threshold, limit) };
  }

  async summary(actor: FlowActor, query: Record<string, unknown>) {
    StoreFlowsUseCases.role(actor, 'personal');
    const { from, to } = parseRangeQuery(query, todayInEcuador(this.now()));
    return this.flows.summary(from, to);
  }

  // -------------------------------------------------------------------------------------- libreta de direcciones (cliente)

  async listAddresses(actor: FlowActor) {
    StoreFlowsUseCases.role(actor, 'cliente');
    return { items: await this.flows.listAddresses(actor.id) };
  }

  async createAddress(actor: FlowActor, body: unknown) {
    StoreFlowsUseCases.role(actor, 'cliente');
    return this.flows.createAddress(actor.id, parseNewAddress(bodyObject(body)));
  }

  async updateAddress(actor: FlowActor, id: unknown, body: unknown) {
    StoreFlowsUseCases.role(actor, 'cliente');
    const { patch, expectedVersion } = parseAddressPatch(bodyObject(body));
    return this.flows.updateAddress(actor.id, validateUuid(id, 'La dirección'), patch, expectedVersion);
  }

  async deleteAddress(actor: FlowActor, id: unknown) {
    StoreFlowsUseCases.role(actor, 'cliente');
    await this.flows.deleteAddress(actor.id, validateUuid(id, 'La dirección'));
  }
}

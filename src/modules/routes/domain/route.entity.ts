import { RouteIntegrityError, RouteValidationError } from './route.errors.js';
import { validateCapacityLimit, validatePagination, validateServiceDate, validateUuid } from './route.validation.js';
export { POSTGRES_INTEGER_MAX } from './route.validation.js';

export const ROUTE_STATUSES = ['planificada', 'asignada', 'en_curso', 'completada', 'cancelada'] as const;
export type RouteStatus = typeof ROUTE_STATUSES[number];

export const ORDER_STATUSES = ['pendiente', 'asignado_a_ruta', 'recogido', 'en_camino', 'entregado'] as const;
export type StopOrderStatus = typeof ORDER_STATUSES[number];

// The only grouping/ordering policy this sprint exposes: zone + date, then delivery time and ID.
export const PLANNING_ALGORITHM = 'zona_hora_v1' as const;

export interface RoutePlanCommand {
  readonly serviceDate: string;
  readonly capacityLimit: number;
  readonly idempotencyKey: string;
}

export interface RoutePlanResult {
  readonly serviceDate: string;
  readonly routeIds: readonly string[];
}

export interface RouteListQuery {
  readonly serviceDate?: string;
  readonly zoneId?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface RouteSummary {
  readonly id: string;
  readonly zoneId: string;
  readonly serviceDate: string;
  readonly capacityLimit: number;
  readonly status: RouteStatus;
  readonly courierId: string | null;
  readonly occupiedSlots: number;
}

export interface RouteStop {
  readonly orderId: string;
  readonly position: number;
  readonly deliveryAddress: string;
  readonly deliveryDate: string;
  readonly deliveryTime: string;
  readonly status: StopOrderStatus;
}

// zoneId of each stop is kept for the integrity policy only; it is not part of the HTTP contract.
export interface RouteStopRecord extends RouteStop {
  readonly zoneId: string;
}

export interface RouteDetail extends RouteSummary {
  readonly stops: readonly RouteStop[];
}

export interface RouteListPage {
  readonly items: readonly RouteSummary[];
  readonly limit: number;
  readonly offset: number;
}

export interface NewRoute {
  readonly zoneId: string;
  readonly serviceDate: string;
  readonly capacityLimit: number;
}

export interface RouteProperties extends NewRoute {
  readonly id: string;
  readonly status: RouteStatus;
  readonly courierId?: string | null;
  readonly occupiedSlots?: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly stops?: readonly RouteStop[];
  readonly metadata?: Record<string, unknown>;
}

export class Route {
  private _occupiedSlots: number;
  private readonly _stops: RouteStop[];

  private constructor(private readonly properties: RouteProperties) {
    this._occupiedSlots = properties.occupiedSlots ?? 0;
    this._stops = properties.stops ? [...properties.stops] : [];
  }

  get id(): string { return this.properties.id; }
  get zoneId(): string { return this.properties.zoneId; }
  get serviceDate(): string { return this.properties.serviceDate; }
  get capacityLimit(): number { return this.properties.capacityLimit; }
  get status(): RouteStatus { return this.properties.status; }
  get courierId(): string | null { return this.properties.courierId ?? null; }
  get occupiedSlots(): number { return this._occupiedSlots; }
  get createdAt(): Date { return new Date(this.properties.createdAt); }
  get updatedAt(): Date { return new Date(this.properties.updatedAt); }
  get stops(): readonly RouteStop[] { return [...this._stops]; }
  get metadata(): Record<string, unknown> { return { ...(this.properties.metadata ?? {}) }; }
  get availableSlots(): number { return Math.max(0, this.properties.capacityLimit - this._occupiedSlots); }

  canAcceptStop(): boolean {
    return this._occupiedSlots < this.properties.capacityLimit;
  }

  addStop(stop: RouteStop): void {
    if (this._occupiedSlots >= this.properties.capacityLimit) {
      throw new RouteIntegrityError('La ruta supera su capacidad por salida.');
    }
    if (this._stops.some((s) => s.orderId === stop.orderId)) {
      throw new RouteIntegrityError('Un pedido aparece dos veces en la ruta.');
    }
    this._stops.push(stop);
    this._occupiedSlots += 1;
  }

  static prepare(properties: NewRoute): NewRoute {
    const zoneId = validateUuid(properties.zoneId, 'zoneId');
    const serviceDate = validateServiceDate(properties.serviceDate);

    const today = new Date().toISOString().slice(0, 10);
    if (serviceDate < today) {
      throw new RouteValidationError('La fecha de servicio no puede ser una fecha pasada.');
    }

    const capacityLimit = validateCapacityLimit(properties.capacityLimit);
    return { zoneId, serviceDate, capacityLimit };
  }

  static create(properties: RouteProperties): Route {
    const prepared = Route.prepare(properties);
    const id = validateUuid(properties.id, 'id');

    if (!isRouteStatus(properties.status)) {
      throw new RouteValidationError('Estado de ruta desconocido.');
    }

    if (
      !(properties.createdAt instanceof Date) || !Number.isFinite(properties.createdAt.getTime()) ||
      !(properties.updatedAt instanceof Date) || !Number.isFinite(properties.updatedAt.getTime()) ||
      properties.updatedAt.getTime() < properties.createdAt.getTime()
    ) {
      throw new RouteValidationError('Los metadatos de fecha de la ruta son inválidos.');
    }

    const occupiedSlots = properties.occupiedSlots ?? 0;
    if (!Number.isInteger(occupiedSlots) || occupiedSlots < 0) {
      throw new RouteValidationError('Ocupación de ruta inválida.');
    }
    if (occupiedSlots > prepared.capacityLimit) {
      throw new RouteIntegrityError('La ruta supera su capacidad por salida.');
    }

    if (properties.stops && properties.stops.length !== occupiedSlots) {
      throw new RouteIntegrityError('Las paradas vigentes no coinciden con la ocupación.');
    }

    return new Route({
      ...properties,
      ...prepared,
      id,
      occupiedSlots,
      createdAt: new Date(properties.createdAt),
      updatedAt: new Date(properties.updatedAt),
      metadata: properties.metadata ? { ...properties.metadata } : {},
      stops: properties.stops ? [...properties.stops] : [],
    });
  }

  toJSON(): RouteSummary {
    return {
      id: this.id,
      zoneId: this.zoneId,
      serviceDate: this.serviceDate,
      capacityLimit: this.capacityLimit,
      status: this.status,
      courierId: this.courierId,
      occupiedSlots: this.occupiedSlots,
    };
  }
}

function isRouteStatus(value: unknown): value is RouteStatus {
  return typeof value === 'string' && (ROUTE_STATUSES as readonly string[]).includes(value);
}

function isStopOrderStatus(value: unknown): value is StopOrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

function integrity(condition: boolean, message: string): void {
  if (!condition) throw new RouteIntegrityError(message);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export const RoutePlanning = {
  prepare(input: { serviceDate: unknown; capacityLimit: unknown; idempotencyKey: unknown }): RoutePlanCommand {
    return {
      idempotencyKey: validateUuid(input.idempotencyKey, 'Idempotency-Key'),
      serviceDate: validateServiceDate(input.serviceDate),
      capacityLimit: validateCapacityLimit(input.capacityLimit),
    };
  },

  prepareListQuery(input: { serviceDate?: string; zoneId?: string; limit?: string; offset?: string }): RouteListQuery {
    return {
      ...(input.serviceDate !== undefined ? { serviceDate: validateServiceDate(input.serviceDate) } : {}),
      ...(input.zoneId !== undefined ? { zoneId: validateUuid(input.zoneId, 'zoneId') } : {}),
      ...validatePagination(input.limit, input.offset),
    };
  },

  // The plan answers only the requested day, with distinct route identities.
  acceptResult(command: RoutePlanCommand, result: { serviceDate: unknown; routeIds: unknown }): RoutePlanResult {
    integrity(result.serviceDate === command.serviceDate, 'La planificación devolvió un día distinto del solicitado.');
    integrity(Array.isArray(result.routeIds), 'La planificación no devolvió una lista de rutas.');
    const routeIds = (result.routeIds as unknown[]).map((id) => {
      integrity(typeof id === 'string', 'La planificación devolvió un identificador inválido.');
      return validateUuid(id, 'routeId');
    });
    integrity(new Set(routeIds).size === routeIds.length, 'La planificación devolvió rutas repetidas.');
    return { serviceDate: command.serviceDate, routeIds };
  },

  summary(record: RouteSummary): RouteSummary {
    integrity(isRouteStatus(record.status), 'Estado de ruta desconocido.');
    integrity(Number.isInteger(record.capacityLimit) && record.capacityLimit >= 1, 'Capacidad de ruta inválida.');
    integrity(nonNegativeInteger(record.occupiedSlots), 'Ocupación de ruta inválida.');
    integrity(record.occupiedSlots <= record.capacityLimit, 'La ruta supera su capacidad por salida.');
    return {
      id: record.id,
      zoneId: record.zoneId,
      serviceDate: record.serviceDate,
      capacityLimit: record.capacityLimit,
      status: record.status,
      courierId: record.courierId,
      occupiedSlots: record.occupiedSlots,
    };
  },

  // Stops never mix day or zone, never repeat an order or position and fit the capacity.
  detail(record: RouteSummary, stops: readonly RouteStopRecord[]): RouteDetail {
    const summary = RoutePlanning.summary(record);
    integrity(stops.length === summary.occupiedSlots, 'Las paradas vigentes no coinciden con la ocupación.');
    integrity(new Set(stops.map((stop) => stop.orderId)).size === stops.length, 'Un pedido aparece dos veces en la ruta.');
    integrity(new Set(stops.map((stop) => stop.position)).size === stops.length, 'Dos paradas comparten posición.');
    for (const stop of stops) {
      integrity(stop.deliveryDate === summary.serviceDate, 'Una parada pertenece a otro día de entrega.');
      integrity(stop.zoneId === summary.zoneId, 'Una parada pertenece a otra zona.');
      integrity(isStopOrderStatus(stop.status), 'Estado de pedido desconocido.');
      integrity(Number.isInteger(stop.position) && stop.position >= 1, 'Posición de parada inválida.');
    }
    const ordered = [...stops].sort((left, right) => left.position - right.position);
    return {
      ...summary,
      stops: ordered.map((stop) => ({
        orderId: stop.orderId,
        position: stop.position,
        deliveryAddress: stop.deliveryAddress,
        deliveryDate: stop.deliveryDate,
        deliveryTime: stop.deliveryTime,
        status: stop.status,
      })),
    };
  },
};

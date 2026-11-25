import { isWithinEcuador } from '../../../shared/geo.js';
import { OrderValidationError } from './order.errors.js';
import { validateDeliveryDate, validateDeliveryTime, validateUuid } from './order.validation.js';

const ORDER_STATUSES = ['pendiente', 'asignado_a_ruta', 'recogido', 'en_camino', 'entregado', 'entrega_fallida', 'cancelado'] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];

export interface OrderDelivery {
  readonly zoneId: string;
  readonly deliveryAddress: string;
  readonly deliveryDate: string;
  readonly deliveryTime: string;
  /** Punto del mapa del pedido; opcional, pero siempre las dos coordenadas juntas y dentro de Ecuador. */
  readonly latitude?: number | null;
  readonly longitude?: number | null;
}

// Registration contains no identity or timestamps supplied by the caller.
export interface NewOrder extends OrderDelivery {
  readonly status: 'pendiente';
}

export interface OrderProperties extends OrderDelivery {
  readonly id: string;
  readonly status: OrderStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrderDto extends OrderDelivery {
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly id: string;
  readonly status: OrderStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class Order {
  private constructor(private readonly properties: OrderProperties) {}

  get id(): string { return this.properties.id; }
  get zoneId(): string { return this.properties.zoneId; }
  get deliveryAddress(): string { return this.properties.deliveryAddress; }
  get deliveryDate(): string { return this.properties.deliveryDate; }
  get deliveryTime(): string { return this.properties.deliveryTime; }
  get latitude(): number | null { return this.properties.latitude ?? null; }
  get longitude(): number | null { return this.properties.longitude ?? null; }
  get status(): OrderStatus { return this.properties.status; }
  get createdAt(): Date { return new Date(this.properties.createdAt); }
  get updatedAt(): Date { return new Date(this.properties.updatedAt); }

  /** Valida el pin: ambas coordenadas o ninguna, números finitos dentro de Ecuador. */
  static validatePin(latitude: unknown, longitude: unknown): { latitude: number | null; longitude: number | null } {
    const noLat = latitude === undefined || latitude === null;
    const noLng = longitude === undefined || longitude === null;
    if (noLat && noLng) return { latitude: null, longitude: null };
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new OrderValidationError('La latitud y la longitud deben enviarse juntas y ser números.');
    }
    if (!isWithinEcuador(latitude, longitude)) {
      throw new OrderValidationError('El punto de entrega debe estar dentro de Ecuador.');
    }
    return { latitude, longitude };
  }

  static prepare(properties: OrderDelivery): NewOrder {
    if (typeof properties.deliveryAddress !== 'string' || properties.deliveryAddress.trim().length === 0) {
      throw new OrderValidationError('La dirección de entrega no puede estar vacía.');
    }
    return {
      zoneId: validateUuid(properties.zoneId, 'zoneId'),
      deliveryAddress: properties.deliveryAddress.trim(),
      deliveryDate: validateDeliveryDate(properties.deliveryDate),
      deliveryTime: validateDeliveryTime(properties.deliveryTime),
      ...Order.validatePin(properties.latitude, properties.longitude),
      status: 'pendiente',
    };
  }

  // Rehydrate a persisted order; this method never reads the clock or generates IDs.
  static create(properties: OrderProperties): Order {
    const delivery = Order.prepare(properties);
    const id = validateUuid(properties.id, 'id');
    if (!ORDER_STATUSES.includes(properties.status)) {
      throw new OrderValidationError('El estado del pedido es inválido.');
    }
    if (
      !(properties.createdAt instanceof Date) || !Number.isFinite(properties.createdAt.getTime()) ||
      !(properties.updatedAt instanceof Date) || !Number.isFinite(properties.updatedAt.getTime()) ||
      properties.updatedAt.getTime() < properties.createdAt.getTime()
    ) {
      throw new OrderValidationError('Los metadatos de fecha del pedido son inválidos.');
    }
    return new Order({
      ...delivery,
      id,
      status: properties.status,
      createdAt: new Date(properties.createdAt),
      updatedAt: new Date(properties.updatedAt),
    });
  }

  toJSON(): OrderDto {
    return {
      id: this.id,
      zoneId: this.zoneId,
      deliveryAddress: this.deliveryAddress,
      deliveryDate: this.deliveryDate,
      deliveryTime: this.deliveryTime,
      latitude: this.latitude,
      longitude: this.longitude,
      status: this.status,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}

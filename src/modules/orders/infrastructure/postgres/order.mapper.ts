import { Order, type OrderStatus } from '../../domain/order.entity.js';
import { OrderPersistenceUnavailableError } from '../../domain/order.errors.js';

export interface PrismaOrderRecord {
  readonly id: string;
  readonly zoneId: string;
  readonly deliveryAddress: string;
  readonly deliveryDate: string;
  readonly deliveryTime: string;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly status: string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

function timestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return new Date(value);
  throw new OrderPersistenceUnavailableError();
}

export function mapOrderRecord(value: unknown): Order {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new OrderPersistenceUnavailableError();
    }
    const record = value as PrismaOrderRecord;
    return Order.create({
      id: record.id,
      zoneId: record.zoneId,
      deliveryAddress: record.deliveryAddress,
      deliveryDate: record.deliveryDate,
      deliveryTime: record.deliveryTime,
      latitude: record.latitude ?? null,
      longitude: record.longitude ?? null,
      status: record.status as OrderStatus,
      createdAt: timestamp(record.createdAt),
      updatedAt: timestamp(record.updatedAt),
    });
  } catch {
    throw new OrderPersistenceUnavailableError();
  }
}

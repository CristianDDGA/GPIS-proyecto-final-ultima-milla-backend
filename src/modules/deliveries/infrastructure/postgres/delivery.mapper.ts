import { isActorRole, type Actor } from '../../domain/actor.js';
import { DeliveryError } from '../../domain/delivery.errors.js';
import {
  validateOrderId,
  validateOrderStatus,
  validatePositiveVersion,
  validateRouteId,
  validateTargetStatus,
  type DeliveryOrder,
  type DeliveryStatusChangeResult,
} from '../../domain/delivery-order.js';

const ISO_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function toUtcIsoString(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
    }
    return value.toISOString();
  }
  if (typeof value === 'string' && ISO_TIMESTAMP_REGEX.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
  }
  return value as Record<string, unknown>;
}

export function mapActorRow(value: unknown): Actor {
  try {
    const record = asRecord(value);
    const id = validateOrderId(record['id']);
    const authSubject = record['authSubject'];
    const role = record['role'];
    const isActive = record['isActive'];

    if (
      typeof authSubject !== 'string' ||
      authSubject.trim().length === 0 ||
      !isActorRole(role) ||
      typeof isActive !== 'boolean'
    ) {
      throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
    }

    return {
      id,
      authSubject,
      role,
      isActive,
    };
  } catch {
    throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
  }
}

export function mapDeliveryOrderRow(value: unknown): DeliveryOrder {
  try {
    const record = asRecord(value);
    const orderId = validateOrderId(record['orderId']);
    const rawRouteId = record['routeId'];
    const routeId = rawRouteId === null ? null : validateRouteId(rawRouteId);
    const status = validateOrderStatus(record['status']);
    const version = validatePositiveVersion(record['version'], 'version');
    const rawDeliveredAt = record['deliveredAt'];
    const deliveredAt = rawDeliveredAt === null ? null : toUtcIsoString(rawDeliveredAt);
    const updatedAt = toUtcIsoString(record['updatedAt']);

    return {
      orderId,
      routeId,
      status,
      version,
      deliveredAt,
      updatedAt,
    };
  } catch {
    throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
  }
}

export function mapStatusChangeResultRow(
  value: unknown,
  expectedOrderId: string,
): DeliveryStatusChangeResult {
  try {
    const record = asRecord(value);
    const orderId = validateOrderId(record['orderId']);
    if (orderId !== expectedOrderId) {
      throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
    }
    const status = validateTargetStatus(record['status']);
    const version = validatePositiveVersion(record['version'], 'version');
    return {
      orderId,
      status,
      version,
    };
  } catch {
    throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
  }
}

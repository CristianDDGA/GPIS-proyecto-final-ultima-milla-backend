import { assertActorActive, type Actor } from './actor.js';
import { DeliveryError } from './delivery.errors.js';

export type OrderStatus =
  | 'pendiente'
  | 'asignado_a_ruta'
  | 'recogido'
  | 'en_camino'
  | 'entregado';

export type TargetDeliveryStatus = 'recogido' | 'en_camino' | 'entregado';

export interface DeliveryOrder {
  readonly orderId: string;
  readonly routeId: string | null;
  readonly status: OrderStatus;
  readonly version: string;
  readonly deliveredAt: string | null;
  readonly updatedAt: string;
}

export interface DeliveryStatusChangeCommand {
  readonly orderId: string;
  readonly newStatus: TargetDeliveryStatus;
  readonly expectedVersion: string;
  readonly idempotencyKey: string;
}

export interface DeliveryStatusChangeResult {
  readonly orderId: string;
  readonly status: TargetDeliveryStatus;
  readonly version: string;
}

export interface RouteCompletionResult {
  readonly routeId: string;
  readonly status: 'completada';
}

export interface OrderAssignmentOwnership {
  readonly assigned: boolean;
  readonly courierUserId: string | null;
  readonly courierEnabled: boolean;
}

export const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<OrderStatus, TargetDeliveryStatus | null>
> = {
  pendiente: null,
  asignado_a_ruta: 'recogido',
  recogido: 'en_camino',
  en_camino: 'entregado',
  entregado: null,
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_DECIMAL_REGEX = /^[1-9]\d*$/;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

function validateUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new DeliveryError('VALIDATION_ERROR', `${label} debe ser un UUID válido.`);
  }
  return value.toLowerCase();
}

export function validateOrderId(value: unknown): string {
  return validateUuid(value, 'orderId');
}

export function validateRouteId(value: unknown): string {
  return validateUuid(value, 'routeId');
}

export function validateIdempotencyKey(value: unknown): string {
  return validateUuid(value, 'Idempotency-Key');
}

export function validateOrderStatus(value: unknown): OrderStatus {
  if (
    value === 'pendiente' ||
    value === 'asignado_a_ruta' ||
    value === 'recogido' ||
    value === 'en_camino' ||
    value === 'entregado'
  ) {
    return value;
  }
  throw new DeliveryError('VALIDATION_ERROR', 'Estado de pedido inválido.');
}

export function validateTargetStatus(value: unknown): TargetDeliveryStatus {
  if (value === 'recogido' || value === 'en_camino' || value === 'entregado') {
    return value;
  }
  throw new DeliveryError(
    'VALIDATION_ERROR',
    'newStatus debe ser recogido, en_camino o entregado.',
  );
}

export function validatePositiveVersion(
  value: unknown,
  fieldName = 'expectedVersion',
): string {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_REGEX.test(value)) {
    throw new DeliveryError(
      'VALIDATION_ERROR',
      `${fieldName} debe ser una cadena decimal positiva.`,
    );
  }
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > MAX_POSTGRES_BIGINT) {
    throw new DeliveryError(
      'VALIDATION_ERROR',
      `${fieldName} excede el rango permitido de versión.`,
    );
  }
  return value;
}

export function validateStatusChangeInput(input: {
  readonly orderId: unknown;
  readonly newStatus: unknown;
  readonly expectedVersion: unknown;
  readonly idempotencyKey: unknown;
}): DeliveryStatusChangeCommand {
  return {
    orderId: validateOrderId(input.orderId),
    newStatus: validateTargetStatus(input.newStatus),
    expectedVersion: validatePositiveVersion(input.expectedVersion, 'expectedVersion'),
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
  };
}

export function isAllowedStatusTransition(
  currentStatus: OrderStatus,
  targetStatus: TargetDeliveryStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS[currentStatus] === targetStatus;
}

export function assertValidStatusTransition(
  currentStatus: OrderStatus,
  targetStatus: TargetDeliveryStatus,
): void {
  if (!isAllowedStatusTransition(currentStatus, targetStatus)) {
    throw new DeliveryError(
      'DATA_CONFLICT',
      `Transición de estado no permitida: ${currentStatus} -> ${targetStatus}.`,
    );
  }
}

export function assertExpectedVersionMatches(
  currentVersion: string,
  expectedVersion: string,
): void {
  if (currentVersion !== expectedVersion) {
    throw new DeliveryError(
      'DATA_CONFLICT',
      'La versión del pedido cambió antes de aplicar la actualización.',
    );
  }
}

export function assertActorCanChangeOrderStatus(
  actor: Actor,
  ownership: OrderAssignmentOwnership,
): void {
  assertActorActive(actor);
  if (actor.role === 'repartidor') {
    if (
      !ownership.assigned ||
      !ownership.courierEnabled ||
      !ownership.courierUserId ||
      ownership.courierUserId !== actor.id
    ) {
      throw new DeliveryError(
        'FORBIDDEN',
        'El repartidor solo puede modificar pedidos asignados a su ruta.',
      );
    }
  }
}

export function assertRouteCompletable(
  routeStatus: string,
  stopOrderStatuses: readonly OrderStatus[],
): void {
  if (routeStatus !== 'en_curso') {
    throw new DeliveryError(
      'DATA_CONFLICT',
      'Solo se puede completar una ruta en estado en_curso.',
    );
  }
  if (stopOrderStatuses.length === 0) {
    throw new DeliveryError(
      'DATA_CONFLICT',
      'La ruta no tiene paradas activas para completar.',
    );
  }
  if (stopOrderStatuses.some(status => status !== 'entregado')) {
    throw new DeliveryError(
      'DATA_CONFLICT',
      'Todos los pedidos de la ruta deben estar entregados antes de completarla.',
    );
  }
}

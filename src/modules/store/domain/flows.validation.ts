import { validateAddressText, validatePersonName } from '../../../shared/text-validation.js';
import { validateProductDescription } from '../../../shared/store-text-validation.js';
import { validateCategoryName } from '../../../shared/store-text-validation.js';
import {
  MAX_PRICE_CENTS,
  boolean,
  checkedText,
  expectedVersion,
  fail,
  integer,
  isIsoDate,
  nullableText,
  onlyKeys,
  parseIdempotencyKey,
  queryInteger,
  queryString,
  requireField,
  validateUuid,
} from './store.validation.js';
import {
  CANCEL_REASONS,
  FAILURE_REASONS,
  type AddressPatch,
  type AdminOrderFilter,
  type CancelReason,
  type FailureReason,
  type NewAddress,
} from './flows.types.js';

// Validación de entrada de los flujos por rol. Misma política: tipos estrictos, campos permitidos y rangos.

const ORDER_STATUS_FILTER = ['pendiente', 'asignado_a_ruta', 'recogido', 'en_camino', 'entregado', 'entrega_fallida', 'cancelado'];
const MAX_NOTE = 300;

function optionalNote(body: Record<string, unknown>, label: string): string | null {
  if (!('note' in body) || body['note'] === null || body['note'] === '') return null;
  const text = checkedText(validateProductDescription(body['note'], label));
  if (text.length > MAX_NOTE) fail(`${label} no puede superar ${MAX_NOTE} caracteres.`);
  return text;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return fail(`${label} debe ser uno de: ${allowed.join(', ')}.`);
  return value as T;
}

export function parseCancel(body: Record<string, unknown>): { reason: CancelReason; note: string | null } {
  onlyKeys(body, ['reason', 'note']);
  return { reason: oneOf(requireField(body, 'reason', 'El motivo'), CANCEL_REASONS, 'El motivo'), note: optionalNote(body, 'La nota') };
}

export function parseReschedule(body: Record<string, unknown>): { deliveryDate: string; deliveryTime: string } {
  onlyKeys(body, ['deliveryDate', 'deliveryTime']);
  const date = requireField(body, 'deliveryDate', 'La fecha de entrega');
  if (typeof date !== 'string' || !isIsoDate(date)) return fail('La fecha de entrega debe tener formato AAAA-MM-DD y ser una fecha real.');
  const time = requireField(body, 'deliveryTime', 'La hora de entrega');
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):00$/.test(time)) return fail('La hora de entrega debe ser una hora en punto con formato HH:00.');
  return { deliveryDate: date, deliveryTime: time };
}

export function parseDeliver(body: Record<string, unknown>, key: unknown): { expectedVersion: number; collectedCents: number; idempotencyKey: string } {
  onlyKeys(body, ['expectedVersion', 'collectedCents']);
  return {
    expectedVersion: expectedVersion(body),
    collectedCents: integer(requireField(body, 'collectedCents', 'El monto cobrado'), 'collectedCents', 1, MAX_PRICE_CENTS * 20),
    idempotencyKey: parseIdempotencyKey(key),
  };
}

export function parseFail(
  body: Record<string, unknown>,
  key: unknown,
): { expectedVersion: number; reason: FailureReason; note: string | null; idempotencyKey: string } {
  onlyKeys(body, ['expectedVersion', 'reason', 'note']);
  return {
    expectedVersion: expectedVersion(body),
    reason: oneOf(requireField(body, 'reason', 'El motivo'), FAILURE_REASONS, 'El motivo'),
    note: optionalNote(body, 'La nota'),
    idempotencyKey: parseIdempotencyKey(key),
  };
}

function phone(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\+?\d(?:[ -]?\d){6,14}$/.test(value.trim())) return fail('El teléfono debe tener entre 7 y 15 dígitos (puede iniciar con +).');
  return value.trim().replace(/[ -]/g, '');
}

function recipient(value: unknown): string | null {
  if (value === null || value === '') return null;
  return checkedText(validatePersonName(value, 'El nombre del destinatario'));
}

export function parseNewAddress(body: Record<string, unknown>): NewAddress {
  onlyKeys(body, ['label', 'zoneId', 'address', 'recipientName', 'recipientPhone', 'isDefault']);
  return {
    label: checkedText(validateCategoryName(requireField(body, 'label', 'El nombre de la dirección'), 'El nombre de la dirección')),
    zoneId: validateUuid(requireField(body, 'zoneId', 'La zona'), 'zoneId'),
    address: checkedText(validateAddressText(requireField(body, 'address', 'La dirección'), 'La dirección')),
    recipientName: 'recipientName' in body ? recipient(body['recipientName']) : null,
    recipientPhone: 'recipientPhone' in body ? phone(body['recipientPhone']) : null,
    isDefault: 'isDefault' in body ? boolean(body['isDefault'], 'isDefault') : false,
  };
}

export function parseAddressPatch(body: Record<string, unknown>): { patch: AddressPatch; expectedVersion: number } {
  onlyKeys(body, ['expectedVersion', 'label', 'zoneId', 'address', 'recipientName', 'recipientPhone', 'isDefault']);
  const version = expectedVersion(body);
  const patch: { -readonly [K in keyof AddressPatch]: AddressPatch[K] } = {};
  if ('label' in body) patch.label = checkedText(validateCategoryName(body['label'], 'El nombre de la dirección'));
  if ('zoneId' in body) patch.zoneId = validateUuid(body['zoneId'], 'zoneId');
  if ('address' in body) patch.address = checkedText(validateAddressText(body['address'], 'La dirección'));
  if ('recipientName' in body) patch.recipientName = recipient(body['recipientName']);
  if ('recipientPhone' in body) patch.recipientPhone = phone(body['recipientPhone']);
  if ('isDefault' in body) patch.isDefault = boolean(body['isDefault'], 'isDefault');
  if (Object.keys(patch).length === 0) fail('No hay cambios que aplicar.');
  return { patch, expectedVersion: version };
}

export function parseSettle(body: Record<string, unknown>): { courierUserId: string; date: string; receivedCents: number; note: string | null } {
  onlyKeys(body, ['courierUserId', 'date', 'receivedCents', 'note']);
  const date = requireField(body, 'date', 'La fecha');
  if (typeof date !== 'string' || !isIsoDate(date)) return fail('La fecha debe tener formato AAAA-MM-DD y ser una fecha real.');
  return {
    courierUserId: validateUuid(requireField(body, 'courierUserId', 'El conductor'), 'courierUserId'),
    date,
    receivedCents: integer(requireField(body, 'receivedCents', 'El monto recibido'), 'receivedCents', 0, MAX_PRICE_CENTS * 200),
    note: optionalNote(body, 'La nota'),
  };
}

export function parseDateQuery(query: Record<string, unknown>, today: string): string {
  const raw = queryString(query, 'date');
  if (raw === undefined || raw === '') return today;
  if (!isIsoDate(raw)) return fail('date debe ser una fecha válida con formato AAAA-MM-DD.');
  return raw;
}

export function parseRangeQuery(query: Record<string, unknown>, today: string): { from: string; to: string } {
  const from = parseDateQuery({ date: query['from'] }, today);
  const to = parseDateQuery({ date: query['to'] }, from);
  if (from > to) return fail('from no puede ser posterior a to.');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > 366) return fail('El rango no puede superar 366 días.');
  return { from, to };
}

export function parseAdminOrderFilter(query: Record<string, unknown>): AdminOrderFilter & { expand: boolean } {
  const status = queryString(query, 'status');
  if (status !== undefined && status !== '' && !ORDER_STATUS_FILTER.includes(status)) return fail(`status debe ser uno de: ${ORDER_STATUS_FILTER.join(', ')}.`);
  const date = queryString(query, 'deliveryDate');
  if (date !== undefined && date !== '' && !isIsoDate(date)) return fail('deliveryDate debe ser una fecha válida con formato AAAA-MM-DD.');
  const zone = queryString(query, 'zoneId');
  const expand = queryString(query, 'expand');
  if (expand !== undefined && expand !== '' && expand !== 'items') return fail('expand solo admite items.');
  return {
    ...(status ? { status } : {}),
    ...(date ? { deliveryDate: date } : {}),
    ...(zone ? { zoneId: validateUuid(zone, 'zoneId') } : {}),
    expand: expand === 'items',
  };
}

export function parseThreshold(query: Record<string, unknown>): { threshold: number; limit: number } {
  return {
    threshold: queryInteger(query, 'threshold', 0, 1000) ?? 5,
    limit: queryInteger(query, 'limit', 1, 100) ?? 50,
  };
}

export { nullableText };

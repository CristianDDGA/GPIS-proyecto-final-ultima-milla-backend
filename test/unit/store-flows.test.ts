import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmailMessage, EmailSender } from '../../src/modules/auth/application/ports/email-sender.port.js';
import { todayInEcuador } from '../../src/modules/store/application/flows.use-cases.js';
import { NotificationWorker, buildNotificationEmail, canEmail, orderCode } from '../../src/modules/store/application/notification-worker.js';
import {
  parseAddressPatch,
  parseAdminOrderFilter,
  parseCancel,
  parseDeliver,
  parseFail,
  parseNewAddress,
  parseRangeQuery,
  parseReschedule,
  parseSettle,
  parseThreshold,
} from '../../src/modules/store/domain/flows.validation.js';
import { StoreError } from '../../src/modules/store/domain/store.errors.js';
import { parseCoordinates, parsePlaceOrder } from '../../src/modules/store/domain/store.validation.js';
import { InMemoryStoreRepository } from '../../src/modules/store/infrastructure/in-memory/in-memory-store.repository.js';
import { mapStoreSqlError } from '../../src/modules/store/infrastructure/postgres/store-sql-errors.js';
import type { PendingNotification } from '../../src/modules/store/domain/flows.types.js';

const UUID = '3f2b8c1e-5d4a-4b7e-9c10-0a1b2c3d4e5f';
const KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

const rejects = (action: () => unknown, code = 'VALIDATION_ERROR') =>
  assert.throws(action, (error: unknown) => error instanceof StoreError && error.code === code);

// ------------------------------------------------------------------------------------------- validación

test('cancelar: motivo cerrado, nota opcional y limpia', () => {
  assert.deepEqual(parseCancel({ reason: 'sin_stock' }), { reason: 'sin_stock', note: null });
  assert.deepEqual(parseCancel({ reason: 'otro', note: 'Cambio de planes' }), { reason: 'otro', note: 'Cambio de planes' });
  assert.equal(parseCancel({ reason: 'otro', note: '' }).note, null);
  rejects(() => parseCancel({}));
  rejects(() => parseCancel({ reason: 'porque_si' }));
  rejects(() => parseCancel({ reason: 7 }));
  rejects(() => parseCancel({ reason: 'otro', extra: true }));
  rejects(() => parseCancel({ reason: 'otro', note: 'x'.repeat(301) }));
  rejects(() => parseCancel({ reason: 'otro', note: 'Con emoji \u{1F600}' }));
});

test('reprogramar: fecha real y hora en punto', () => {
  assert.deepEqual(parseReschedule({ deliveryDate: '2030-02-28', deliveryTime: '09:00' }), { deliveryDate: '2030-02-28', deliveryTime: '09:00' });
  rejects(() => parseReschedule({ deliveryDate: '2030-02-30', deliveryTime: '09:00' }));
  rejects(() => parseReschedule({ deliveryDate: '2030-02-28', deliveryTime: '09:30' }));
  rejects(() => parseReschedule({ deliveryDate: '2030-02-28', deliveryTime: '24:00' }));
  rejects(() => parseReschedule({ deliveryDate: '2030-02-28' }));
  rejects(() => parseReschedule({ deliveryDate: 20300228, deliveryTime: '09:00' }));
});

test('entregar y fallar: versión, monto entero positivo, motivo cerrado y clave obligatoria', () => {
  assert.deepEqual(parseDeliver({ expectedVersion: 3, collectedCents: 5000 }, KEY), { expectedVersion: 3, collectedCents: 5000, idempotencyKey: KEY });
  rejects(() => parseDeliver({ expectedVersion: 3, collectedCents: 0 }, KEY));
  rejects(() => parseDeliver({ expectedVersion: 3, collectedCents: 12.5 }, KEY));
  rejects(() => parseDeliver({ expectedVersion: 3, collectedCents: '5000' }, KEY));
  rejects(() => parseDeliver({ expectedVersion: 3, collectedCents: 5000 }, undefined));
  rejects(() => parseDeliver({ expectedVersion: 3, collectedCents: 5000 }, 'no-es-uuid'));
  rejects(() => parseDeliver({ collectedCents: 5000 }, KEY));
  assert.deepEqual(parseFail({ expectedVersion: 4, reason: 'cliente_ausente', note: 'Sin respuesta' }, KEY), {
    expectedVersion: 4, reason: 'cliente_ausente', note: 'Sin respuesta', idempotencyKey: KEY,
  });
  rejects(() => parseFail({ expectedVersion: 4, reason: 'no_quiso' }, KEY));
  rejects(() => parseFail({ expectedVersion: 4 }, KEY));
});

test('direcciones: texto estricto, teléfono normalizado y parche no vacío', () => {
  const address = parseNewAddress({ label: 'Casa', zoneId: UUID, address: 'Av. 9 de Octubre 123 y Malecón', recipientPhone: '098 765-4321' });
  assert.equal(address.recipientPhone, '0987654321');
  assert.equal(address.isDefault, false);
  assert.equal(address.recipientName, null);
  rejects(() => parseNewAddress({ label: 'Casa \u{1F600}', zoneId: UUID, address: 'Av. 9 de Octubre 123' }));
  rejects(() => parseNewAddress({ label: 'A', zoneId: UUID, address: 'Av. 9 de Octubre 123' }));
  rejects(() => parseNewAddress({ label: 'Casa', zoneId: 'x', address: 'Av. 9 de Octubre 123' }));
  rejects(() => parseNewAddress({ label: 'Casa', zoneId: UUID, address: 'Av. 9 de Octubre 123', recipientPhone: 'abc' }));
  rejects(() => parseNewAddress({ label: 'Casa', zoneId: UUID, address: 'Av. 9 de Octubre 123', recipientName: 'Ana 99' }));
  rejects(() => parseNewAddress({ label: 'Casa', zoneId: UUID, address: 'Av. 9 de Octubre 123', isDefault: 'si' }));
  rejects(() => parseNewAddress({ label: 'Casa', zoneId: UUID, address: 'Av. 9 de Octubre 123', otro: 1 }));
  assert.deepEqual(parseAddressPatch({ expectedVersion: 2, isDefault: true }), { patch: { isDefault: true }, expectedVersion: 2 });
  rejects(() => parseAddressPatch({ expectedVersion: 2 }));
  rejects(() => parseAddressPatch({ label: 'Casa' }));
});

test('caja y reportes: fechas reales, rango ordenado y límites', () => {
  assert.deepEqual(parseSettle({ courierUserId: UUID, date: '2030-01-05', receivedCents: 0 }), { courierUserId: UUID, date: '2030-01-05', receivedCents: 0, note: null });
  rejects(() => parseSettle({ courierUserId: UUID, date: '2030-01-05', receivedCents: -1 }));
  rejects(() => parseSettle({ courierUserId: UUID, date: 'ayer', receivedCents: 1 }));
  rejects(() => parseSettle({ courierUserId: 'x', date: '2030-01-05', receivedCents: 1 }));
  assert.deepEqual(parseRangeQuery({}, '2030-03-01'), { from: '2030-03-01', to: '2030-03-01' });
  assert.deepEqual(parseRangeQuery({ from: '2030-03-01', to: '2030-03-09' }, '2030-03-01'), { from: '2030-03-01', to: '2030-03-09' });
  rejects(() => parseRangeQuery({ from: '2030-03-09', to: '2030-03-01' }, '2030-03-01'));
  rejects(() => parseRangeQuery({ from: '2030-01-01', to: '2032-01-01' }, '2030-03-01'));
  assert.deepEqual(parseThreshold({}), { threshold: 5, limit: 50 });
  rejects(() => parseThreshold({ threshold: '-1' }));
  assert.equal(parseAdminOrderFilter({ status: 'cancelado', expand: 'items' }).expand, true);
  rejects(() => parseAdminOrderFilter({ status: 'inventado' }));
  rejects(() => parseAdminOrderFilter({ expand: 'todo' }));
  rejects(() => parseAdminOrderFilter({ zoneId: 'x' }));
});

test('la fecha de hoy se calcula en hora de Ecuador (UTC-5)', () => {
  assert.equal(todayInEcuador(new Date('2030-06-15T03:30:00Z')), '2030-06-14');
  assert.equal(todayInEcuador(new Date('2030-06-15T05:00:00Z')), '2030-06-15');
});

// ------------------------------------------------------------------------------------------- errores de base de datos

test('los errores SQL de los flujos se traducen a códigos de negocio', () => {
  const sql = (code: string, message = '') => Object.assign(new Error(message), { code });
  const map = (code: string, message = '') => mapStoreSqlError(sql(code, message)).code;
  assert.equal(map('23514', 'ORDER_NOT_CANCELLABLE'), 'ORDER_NOT_CANCELLABLE');
  assert.equal(map('23514', 'ORDER_NOT_RESCHEDULABLE'), 'ORDER_NOT_RESCHEDULABLE');
  assert.equal(map('23514', 'MAX_DELIVERY_ATTEMPTS'), 'MAX_DELIVERY_ATTEMPTS');
  assert.equal(map('23514', 'COLLECTION_REQUIRED'), 'COLLECTION_REQUIRED');
  assert.equal(map('23514', 'NOT_A_STORE_ORDER'), 'NOT_A_STORE_ORDER');
  assert.equal(map('23514', 'INVALID_ORDER_TRANSITION: entregado -> en_camino'), 'STALE_ORDER');
  assert.equal(map('40001'), 'STALE_ORDER');
  assert.equal(map('LG404', 'ORDER_NOT_FOUND'), 'ORDER_NOT_FOUND');
  assert.equal(map('LG404', 'ADDRESS_NOT_FOUND'), 'ADDRESS_NOT_FOUND');
  assert.equal(map('LG404', 'COURIER_NOT_FOUND'), 'COURIER_NOT_FOUND');
  assert.equal(map('LG413'), 'ADDRESS_LIMIT');
  assert.equal(map('LG422'), 'COLLECTION_AMOUNT_MISMATCH');
  assert.equal(map('23505', 'customer_addresses_label_idx'), 'DUPLICATE_ADDRESS');
  assert.equal(map('23505', 'cash_settlements_courier_user_id_service_date_key'), 'ALREADY_SETTLED');
  assert.equal(map('22023', 'NOTHING_TO_SETTLE'), 'NOTHING_TO_SETTLE');
  assert.equal(map('22023', 'DEFAULT_REQUIRED'), 'VALIDATION_ERROR');
  assert.equal(map('22007'), 'VALIDATION_ERROR');
  assert.equal(map('XX000'), 'PERSISTENCE_UNAVAILABLE');
});

// ------------------------------------------------------------------------------------------- avisos por correo

const notification = (overrides: Partial<PendingNotification> = {}): PendingNotification => ({
  id: UUID, orderId: '8a2f0000-0000-4000-8000-000000000000', kind: 'order_cancelled', statusTo: 'cancelado', attempts: 1,
  email: 'ana@example.com', displayName: 'Ana <b>', emailVerifiedVia: 'code', ...overrides,
});

test('el código corto del pedido sale del identificador', () => {
  assert.equal(orderCode('8a2f0000-0000-4000-8000-000000000000'), '#PED-8A2F');
});

test('solo se escribe a cuentas con correo confirmado por código', () => {
  assert.equal(canEmail(notification()), true);
  assert.equal(canEmail(notification({ emailVerifiedVia: 'demo' })), false);
  assert.equal(canEmail(notification({ emailVerifiedVia: null })), false);
  assert.equal(canEmail(notification({ email: null })), false);
});

test('el correo escapa el nombre y describe cada tipo de aviso', () => {
  const cancelled = buildNotificationEmail(notification(), null);
  assert.ok(cancelled);
  assert.match(cancelled.subject, /#PED-8A2F/);
  assert.ok(!cancelled.html.includes('<b>'));
  assert.ok(cancelled.html.includes('&lt;b&gt;'));
  assert.equal(cancelled.to, 'ana@example.com');
  const moving = buildNotificationEmail(notification({ kind: 'order_status', statusTo: 'en_camino' }), null);
  assert.match(moving?.text ?? '', /va en camino/);
  const failed = buildNotificationEmail(notification({ kind: 'order_status', statusTo: 'entrega_fallida' }), null);
  assert.match(failed?.text ?? '', /reprogramarlo/);
  assert.equal(buildNotificationEmail(notification({ kind: 'order_status', statusTo: 'otro' }), null), null);
  assert.equal(buildNotificationEmail(notification({ kind: 'order_confirmed' }), null), null);
  assert.equal(buildNotificationEmail(notification({ email: null }), null), null);
});

class RecordingMail implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failures = 0;
  async send(message: EmailMessage): Promise<void> {
    if (this.failures > 0) { this.failures -= 1; throw new Error('SMTP caído'); }
    this.sent.push(message);
  }
}

async function queuedOrder(repository: InMemoryStoreRepository, customerId: string) {
  const category = await repository.createCategory('Accesorios', customerId);
  const product = await repository.createProduct({
    sku: 'N-1', name: 'Cable USB', brand: null, description: null, categoryId: category.id, priceCents: 1000,
    compareAtPriceCents: null, stock: 5, imageKey: null, isActive: true,
  }, customerId);
  const placed = await repository.placeOrder({
    customerId, idempotencyKey: KEY, zoneId: UUID, deliveryAddress: 'Av. 9 de Octubre 123', deliveryDate: '2099-01-10', deliveryTime: '10:00',
    recipientName: null, recipientPhone: null, notes: null, items: [{ productId: product.id, quantity: 2, unitPriceCents: 1000 }],
    latitude: null, longitude: null,
  });
  assert.equal(placed.status, 'ok');
  return placed.status === 'ok' ? placed.orderId : '';
}

test('el proceso de avisos envía, omite y reintenta sin perder ni repetir correos', async () => {
  const customerId = '11111111-1111-4111-8111-111111111111';
  const verified = new Map<string, 'code' | 'demo'>([[customerId, 'code']]);
  const repository = new InMemoryStoreRepository({
    userInfo: (id) => ({ email: 'ana@example.com', displayName: 'Ana', verifiedVia: verified.get(id) ?? null }),
  });
  const orderId = await queuedOrder(repository, customerId);
  const mail = new RecordingMail();
  const errors: unknown[] = [];
  const worker = new NotificationWorker(repository, repository, mail, { onError: (error) => errors.push(error) });

  // Falla el primer envío: el aviso queda pendiente y se reintenta.
  mail.failures = 1;
  assert.equal(await worker.runOnce(), 1);
  assert.equal(mail.sent.length, 0);
  assert.equal(errors.length, 1);
  assert.deepEqual(repository.notificationStates(), { pendiente: 1 });

  assert.equal(await worker.runOnce(), 1);
  assert.equal(mail.sent.length, 1);
  assert.match(mail.sent[0]?.text ?? '', /2 x Cable USB/);
  assert.match(mail.sent[0]?.text ?? '', /\$20\.00/);
  assert.deepEqual(repository.notificationStates(), { enviada: 1 });
  assert.equal(await worker.runOnce(), 0);
  assert.equal(mail.sent.length, 1);

  // Una cuenta en modo demo no recibe correo: el aviso se marca como omitido.
  verified.set(customerId, 'demo');
  await repository.cancelOrder({ orderId, actor: { id: customerId, role: 'cliente' }, reason: 'otro', note: null });
  assert.equal(await worker.runOnce(), 1);
  assert.equal(mail.sent.length, 1);
  assert.deepEqual(repository.notificationStates(), { enviada: 1, omitida: 1 });
});

test('tras 5 intentos fallidos el aviso se da por fallido y deja de reclamarse', async () => {
  const customerId = '22222222-2222-4222-8222-222222222222';
  const repository = new InMemoryStoreRepository({ userInfo: () => ({ email: 'luis@example.com', displayName: 'Luis', verifiedVia: 'code' }) });
  await queuedOrder(repository, customerId);
  const mail = new RecordingMail();
  mail.failures = 99;
  const worker = new NotificationWorker(repository, repository, mail, { onError: () => undefined });
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await worker.runOnce(), 1);
  assert.deepEqual(repository.notificationStates(), { fallida: 1 });
  assert.equal(await worker.runOnce(), 0);
});

// ------------------------------------------------------------------------------------------- coordenadas (mapa)

test('coordenadas: ambas o ninguna, números dentro de Ecuador', () => {
  assert.deepEqual(parseCoordinates({}), { latitude: null, longitude: null });
  assert.deepEqual(parseCoordinates({ latitude: null, longitude: null }), { latitude: null, longitude: null });
  assert.deepEqual(parseCoordinates({ latitude: -0.1807, longitude: -78.4678 }), { latitude: -0.1807, longitude: -78.4678 });
  assert.deepEqual(parseCoordinates({ latitude: -0.9, longitude: -89.6 }), { latitude: -0.9, longitude: -89.6 }); // Galápagos
  rejects(() => parseCoordinates({ latitude: -0.18 }));
  rejects(() => parseCoordinates({ longitude: -78.4 }));
  rejects(() => parseCoordinates({ latitude: -0.18, longitude: null }));
  rejects(() => parseCoordinates({ latitude: '-0.18', longitude: '-78.4' }));
  rejects(() => parseCoordinates({ latitude: Number.NaN, longitude: -78.4 }));
  rejects(() => parseCoordinates({ latitude: 40.4, longitude: -3.7 })); // Madrid
  rejects(() => parseCoordinates({ latitude: -0.18, longitude: -60 })); // fuera del rectángulo de Ecuador
});

test('el pedido acepta el pin del mapa y sigue valiendo sin él', () => {
  const base = {
    zoneId: UUID, deliveryAddress: 'Av. Amazonas 123 y Naciones Unidas', deliveryDate: '2030-05-05', deliveryTime: '10:00',
    items: [{ productId: UUID, quantity: 1, unitPriceCents: 500 }],
  };
  const manual = parsePlaceOrder(base, KEY, UUID);
  assert.equal(manual.latitude, null);
  assert.equal(manual.longitude, null);
  const pinned = parsePlaceOrder({ ...base, latitude: -0.18, longitude: -78.47 }, KEY, UUID);
  assert.equal(pinned.latitude, -0.18);
  assert.equal(pinned.longitude, -78.47);
  rejects(() => parsePlaceOrder({ ...base, latitude: -0.18 }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...base, latitude: 10, longitude: 10 }, KEY, UUID));
});

test('direcciones: pin al crear, y el parche lo cambia o lo quita solo con las dos coordenadas', () => {
  const base = { label: 'Casa', zoneId: UUID, address: 'Av. 9 de Octubre 123' };
  assert.equal(parseNewAddress(base).latitude, null);
  assert.deepEqual(
    { lat: parseNewAddress({ ...base, latitude: -2.17, longitude: -79.92 }).latitude, lng: parseNewAddress({ ...base, latitude: -2.17, longitude: -79.92 }).longitude },
    { lat: -2.17, lng: -79.92 },
  );
  rejects(() => parseNewAddress({ ...base, longitude: -79.92 }));
  assert.deepEqual(parseAddressPatch({ expectedVersion: 1, latitude: -2.17, longitude: -79.92 }).patch, { latitude: -2.17, longitude: -79.92 });
  assert.deepEqual(parseAddressPatch({ expectedVersion: 1, latitude: null, longitude: null }).patch, { latitude: null, longitude: null });
  rejects(() => parseAddressPatch({ expectedVersion: 1, latitude: -2.17 }));
  rejects(() => parseAddressPatch({ expectedVersion: 1, latitude: 99, longitude: -79.92 }));
});

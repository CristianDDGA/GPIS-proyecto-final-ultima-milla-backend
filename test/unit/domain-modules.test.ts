import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Order } from '../../src/modules/orders/domain/order.entity.js';
import { OrderValidationError } from '../../src/modules/orders/domain/order.errors.js';
import { isEligible, validateRegistration, validateId } from '../../src/modules/couriers/domain/courier.js';
import { CourierError } from '../../src/modules/couriers/domain/courier.errors.js';
import { assertCanCompleteRoute, type Actor } from '../../src/modules/deliveries/domain/actor.js';
import {
  validateStatusChangeInput,
  assertValidStatusTransition,
} from '../../src/modules/deliveries/domain/delivery-order.js';
import { DeliveryError } from '../../src/modules/deliveries/domain/delivery.errors.js';

test('Order domain: validation and preparation', () => {
  const validOrder = {
    zoneId: 'a0000000-0000-4000-8000-000000000001',
    deliveryAddress: 'Av. Siempre Viva 123',
    deliveryDate: '2026-11-20',
    deliveryTime: '14:30',
  };

  const prepared = Order.prepare(validOrder);
  assert.equal(prepared.status, 'pendiente');
  assert.equal(prepared.deliveryAddress, 'Av. Siempre Viva 123');

  // Dirección vacía
  assert.throws(
    () => Order.prepare({ ...validOrder, deliveryAddress: '   ' }),
    (err: unknown) => err instanceof OrderValidationError,
  );

  // Fecha inválida
  assert.throws(
    () => Order.prepare({ ...validOrder, deliveryDate: '2026-02-31' }),
    (err: unknown) => err instanceof OrderValidationError,
  );
});

test('Courier domain: registration, id and eligibility', () => {
  const courier = {
    id: 'b0000000-0000-4000-8000-000000000002',
    displayName: 'Carlos Repartidor',
    maxOrdersPerTrip: 4,
    isEnabled: true,
    isAvailable: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  assert.equal(isEligible(courier, false), true);
  assert.equal(isEligible(courier, true), false); // con ruta activa no es elegible
  assert.equal(isEligible({ ...courier, isAvailable: false }, false), false);

  assert.throws(
    () => validateRegistration(' ', 4),
    (err: unknown) => err instanceof CourierError,
  );
  assert.throws(
    () => validateRegistration('Juan', 0),
    (err: unknown) => err instanceof CourierError,
  );

  assert.equal(validateId('B0000000-0000-4000-8000-000000000002'), 'b0000000-0000-4000-8000-000000000002');
  assert.throws(
    () => validateId('uuid-no-valido'),
    (err: unknown) => err instanceof CourierError,
  );
});

test('Deliveries domain: status transitions and completion rules', () => {
  const actor: Actor = {
    id: 'c0000000-0000-4000-8000-000000000003',
    authSubject: 'auth0|123',
    role: 'repartidor',
    isActive: true,
  };

  // Validar inputs de cambio de estado
  const input = validateStatusChangeInput({
    orderId: 'd0000000-0000-4000-8000-000000000004',
    newStatus: 'recogido',
    expectedVersion: '1',
    idempotencyKey: 'e0000000-0000-4000-8000-000000000005',
  });
  assert.equal(input.newStatus, 'recogido');
  assert.equal(input.expectedVersion, '1');

  // assertValidStatusTransition: solo asignado_a_ruta -> recogido -> en_camino -> entregado
  assert.doesNotThrow(() => assertValidStatusTransition('asignado_a_ruta', 'recogido'));
  assert.doesNotThrow(() => assertValidStatusTransition('recogido', 'en_camino'));
  assert.doesNotThrow(() => assertValidStatusTransition('en_camino', 'entregado'));

  // Transición inválida (ej: saltar de asignado a entregado)
  assert.throws(
    () => assertValidStatusTransition('asignado_a_ruta', 'entregado'),
    (err: unknown) => err instanceof DeliveryError && err.code === 'DATA_CONFLICT',
  );

  // assertCanCompleteRoute: rechaza si el repartidor no es el asignado
  assert.throws(
    () => assertCanCompleteRoute(actor, 'otro-repartidor-uuid', true),
    (err: unknown) => err instanceof DeliveryError && err.code === 'FORBIDDEN',
  );

  // Acepta si coincide con el usuario del repartidor
  assert.doesNotThrow(() => assertCanCompleteRoute(actor, actor.id, true));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, todayInEcuador } from '../../src/shared/ecuador-date.js';
import { MAX_ORDERS_PER_ROUTE } from '../../src/shared/delivery-limits.js';
import { validateZoneName } from '../../src/shared/text-validation.js';
import { ZoneDeliveryGuardService } from '../../src/modules/zones/application/zone-delivery-guard.service.js';
import { Zone, type ZoneCoverage } from '../../src/modules/zones/domain/zone.entity.js';
import { RoutePlanning } from '../../src/modules/routes/domain/route.entity.js';
import { RouteOperations } from '../../src/modules/routes/domain/route-operation.entity.js';
import {
  MAX_PLANNING_DAYS_AHEAD,
  validatePlanningCapacity,
  validatePlanningDate,
  validateServiceDate,
  validateCapacityLimit,
} from '../../src/modules/routes/domain/route.validation.js';
import { validateRegistration } from '../../src/modules/couriers/domain/courier.js';

const KEY = '4f0c2a8e-1b6d-4c3a-9e2f-7a5b8c1d2e3f';
const TODAY = '2026-11-24';

// ------------------------------------------------------------------------------------------------ nombre de zona

test('nombre de zona: acepta nombres reales de 3 a 40 caracteres', () => {
  for (const name of ['Ambato Centro', 'Cumbayá', 'Av. 12 de Octubre', 'Ficoa (Norte)', 'Sur']) {
    const result = validateZoneName(name, 'El nombre de la zona');
    assert.equal(result.ok, true, name);
  }
});

test('nombre de zona: rechaza lo demasiado corto, lo demasiado largo y lo que no tiene letras suficientes', () => {
  const cases: Array<[string, RegExp]> = [
    ['ab', /entre 3 y 40/],
    ['x'.repeat(41), /entre 3 y 40/],
    ['12', /al menos 2 letras/],
    ['1 2 a b', /al menos 3 letras/],
    ['   ', /obligatorio/],
    ['Zona 😀', /solo admite/],
  ];
  for (const [name, expected] of cases) {
    const result = validateZoneName(name, 'El nombre de la zona');
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.match(result.reason, expected, name);
  }
});

test('nombre de zona: la validación no puede juzgar el significado (por eso la cobertura en el mapa es obligatoria)', () => {
  // Letras válidas sin sentido pasan el texto; lo que da realidad a la zona es su cobertura, sin la cual no recibe pedidos.
  assert.equal(validateZoneName('djakdaskdljas', 'El nombre de la zona').ok, true);
});

// ------------------------------------------------------------------------------------- regla de entrega (zona y pin)

function zone(coverage: ZoneCoverage | null): Zone {
  const now = new Date();
  return Zone.create({ id: '3f2b8c1e-9a4d-4c2b-8e1f-123456789abc', name: 'Ambato Centro', createdAt: now, updatedAt: now, coverage });
}

const COVERAGE: ZoneCoverage = { latitude: -1.2491, longitude: -78.6167, radiusKm: 3 };

function guardFor(found: Zone | null) {
  return new ZoneDeliveryGuardService({ findById: async () => found });
}

test('regla de entrega: un punto dentro de la cobertura es válido', async () => {
  assert.equal(await guardFor(zone(COVERAGE)).check('z', { latitude: -1.2491, longitude: -78.6167 }), null);
  assert.equal(await guardFor(zone(COVERAGE)).check('z', { latitude: -1.2600, longitude: -78.6167 }), null);
});

test('regla de entrega: un punto fuera de la cobertura se rechaza', async () => {
  assert.equal(await guardFor(zone(COVERAGE)).check('z', { latitude: -2.1894, longitude: -79.8891 }), 'ZONE_OUT_OF_COVERAGE');
  assert.equal(await guardFor(zone(COVERAGE)).check('z', { latitude: -1.2491, longitude: -78.5400 }), 'ZONE_OUT_OF_COVERAGE');
});

test('regla de entrega: sin punto se exige el pin, incluso con una sola coordenada', async () => {
  assert.equal(await guardFor(zone(COVERAGE)).check('z', { latitude: null, longitude: null }), 'PIN_REQUIRED');
  assert.equal(await guardFor(zone(COVERAGE)).check('z', { latitude: -1.25, longitude: null }), 'PIN_REQUIRED');
});

test('regla de entrega: una zona sin cobertura no es operativa, con o sin pin', async () => {
  assert.equal(await guardFor(zone(null)).check('z', { latitude: -1.25, longitude: -78.61 }), 'ZONE_NOT_OPERATIONAL');
  assert.equal(await guardFor(zone(null)).check('z', { latitude: null, longitude: null }), 'ZONE_NOT_OPERATIONAL');
});

test('regla de entrega: una zona inactiva tampoco se juzga aquí (la tienda responde zone_inactive)', async () => {
  const now = new Date();
  const inactive = Zone.create({ id: '3f2b8c1e-9a4d-4c2b-8e1f-123456789abc', name: 'Ambato Centro', createdAt: now, updatedAt: now, coverage: COVERAGE, isActive: false });
  assert.equal(await guardFor(inactive).check('z', { latitude: -1.25, longitude: -78.61 }), null);
});

test('regla de entrega: una zona inexistente no se juzga aquí (la capa de pedidos responde 404)', async () => {
  assert.equal(await guardFor(null).check('z', { latitude: -1.25, longitude: -78.61 }), null);
});

// ------------------------------------------------------------------------------------------------------- fechas

test('addDays suma y resta días cruzando mes y año', () => {
  assert.equal(addDays('2026-11-24', 60), '2027-01-23');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
});

test('todayInEcuador usa UTC-5: poco después de la medianoche UTC todavía es el día anterior', () => {
  assert.equal(todayInEcuador(new Date('2026-01-01T03:00:00Z')), '2025-12-31');
  assert.equal(todayInEcuador(new Date('2026-01-01T05:00:00Z')), '2026-01-01');
});

// ------------------------------------------------------------------------------------- planificación de rutas

test('planificación: la fecha va desde hoy hasta 60 días adelante', () => {
  assert.equal(validatePlanningDate(TODAY, TODAY), TODAY);
  assert.equal(validatePlanningDate('2026-11-25', TODAY), '2026-11-25');
  const limit = addDays(TODAY, MAX_PLANNING_DAYS_AHEAD);
  assert.equal(validatePlanningDate(limit, TODAY), limit);
  assert.throws(() => validatePlanningDate(addDays(TODAY, MAX_PLANNING_DAYS_AHEAD + 1), TODAY), /hasta 60 días/);
  assert.throws(() => validatePlanningDate('2026-11-23', TODAY), /fecha pasada/);
  assert.throws(() => validatePlanningDate('2020-01-01', TODAY), /fecha pasada/);
  assert.throws(() => validatePlanningDate('2099-01-01', TODAY), /hasta 60 días/);
});

test('planificación: una fecha mal formada o inexistente sigue siendo error de formato', () => {
  assert.throws(() => validatePlanningDate('24/11/2026', TODAY), /YYYY-MM-DD/);
  assert.throws(() => validatePlanningDate('2026-02-30', TODAY), /calendario/);
  assert.throws(() => validatePlanningDate(undefined, TODAY), /YYYY-MM-DD/);
});

test('planificación: la capacidad va de 1 a 20 pedidos por ruta', () => {
  assert.equal(validatePlanningCapacity(1), 1);
  assert.equal(validatePlanningCapacity(MAX_ORDERS_PER_ROUTE), MAX_ORDERS_PER_ROUTE);
  assert.throws(() => validatePlanningCapacity(MAX_ORDERS_PER_ROUTE + 1), /no puede superar 20/);
  assert.throws(() => validatePlanningCapacity(2_147_483_647), /no puede superar 20/);
  assert.throws(() => validatePlanningCapacity(0), /entero positivo/);
  assert.throws(() => validatePlanningCapacity('4'), /entero positivo/);
});

test('las rutas ya guardadas NO se revalidan con los límites de planificación', () => {
  // Rehidratar datos existentes (capacidad alta, fecha pasada) debe seguir funcionando.
  assert.equal(validateCapacityLimit(500), 500);
  assert.equal(validateServiceDate('2020-01-01'), '2020-01-01');
});

test('RoutePlanning.prepare aplica fecha y capacidad con el reloj que recibe', () => {
  const ok = RoutePlanning.prepare({ serviceDate: '2026-11-30', capacityLimit: 4, idempotencyKey: KEY }, TODAY);
  assert.deepEqual(ok, { idempotencyKey: KEY, serviceDate: '2026-11-30', capacityLimit: 4 });
  assert.throws(() => RoutePlanning.prepare({ serviceDate: '2026-11-30', capacityLimit: 999_999, idempotencyKey: KEY }, TODAY), /no puede superar/);
  assert.throws(() => RoutePlanning.prepare({ serviceDate: '2026-11-01', capacityLimit: 4, idempotencyKey: KEY }, TODAY), /fecha pasada/);
});

test('el pedido tardío usa el mismo tope de capacidad', () => {
  const orderId = '7a1d2c3b-4e5f-4a6b-9c7d-abcdefabcdef';
  assert.equal(RouteOperations.prepareLatePlacement({ orderId, capacityLimit: 20, idempotencyKey: KEY }).capacityLimit, 20);
  assert.throws(() => RouteOperations.prepareLatePlacement({ orderId, capacityLimit: 21, idempotencyKey: KEY }), /no puede superar 20/);
});

test('repartidor: la capacidad por viaje va de 1 a 20', () => {
  assert.equal(validateRegistration('Luis Andrade', 20).maxOrdersPerTrip, 20);
  assert.throws(() => validateRegistration('Luis Andrade', 21), /entre 1 y 20/);
  assert.throws(() => validateRegistration('Luis Andrade', 2_147_483_647), /entre 1 y 20/);
});

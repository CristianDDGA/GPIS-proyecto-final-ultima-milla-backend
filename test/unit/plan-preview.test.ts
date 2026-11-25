import assert from 'node:assert/strict';
import test from 'node:test';
import { RoutePlanning } from '../../src/modules/routes/domain/route.entity.js';
import { PreviewRoutesUseCase } from '../../src/modules/routes/application/use-cases/preview-routes.use-case.js';
import type { RouteRepository } from '../../src/modules/routes/application/ports/route.repository.port.js';
import { Order } from '../../src/modules/orders/domain/order.entity.js';

const TODAY = '2026-11-24';
const ZONE = '3f2b8c1e-9a4d-4c2b-8e1f-123456789abc';
const raw = (zones: unknown[], extra: Record<string, unknown> = {}) => ({
  date: '2026-11-25', capacity: 4, zones, totalOrders: 5, totalRoutes: 2, availableCouriers: 1, ...extra,
});
const zone = { zoneId: ZONE, zoneName: 'Ambato Centro', orders: 5, routes: 2, routeSizes: [4, 1] };
const command = { serviceDate: '2026-11-25', capacityLimit: 4 };

test('vista previa: usa los mismos límites de fecha y capacidad que el plan real', () => {
  assert.deepEqual(RoutePlanning.preparePreview({ serviceDate: '2026-11-25', capacityLimit: 4 }, TODAY), command);
  assert.throws(() => RoutePlanning.preparePreview({ serviceDate: '2026-11-23', capacityLimit: 4 }, TODAY), /fecha pasada/);
  assert.throws(() => RoutePlanning.preparePreview({ serviceDate: '2027-02-01', capacityLimit: 4 }, TODAY), /60 días/);
  assert.throws(() => RoutePlanning.preparePreview({ serviceDate: '2026-11-25', capacityLimit: 21 }, TODAY), /no puede superar 20/);
  assert.throws(() => RoutePlanning.preparePreview({ serviceDate: '2026-11-25', capacityLimit: undefined }, TODAY), /entero positivo/);
});

test('vista previa: acepta un resultado coherente', () => {
  const result = RoutePlanning.acceptPreview(command, raw([zone]));
  assert.equal(result.totalOrders, 5);
  assert.equal(result.totalRoutes, 2);
  assert.deepEqual(result.zones[0]?.routeSizes, [4, 1]);
  assert.equal(result.availableCouriers, 1);
});

test('vista previa: rechaza resultados incoherentes de la base', () => {
  assert.throws(() => RoutePlanning.acceptPreview(command, raw([zone], { date: '2026-11-26' })), /día distinto/);
  assert.throws(() => RoutePlanning.acceptPreview(command, raw([zone], { capacity: 5 })), /otra capacidad/);
  assert.throws(() => RoutePlanning.acceptPreview(command, raw([{ ...zone, routeSizes: [4] }])), /número de rutas/);
  assert.throws(() => RoutePlanning.acceptPreview(command, raw([{ ...zone, routeSizes: [5, 0] }])), /supera la capacidad/);
  assert.throws(() => RoutePlanning.acceptPreview(command, raw([{ ...zone, routeSizes: [3, 1] }])), /no suman/);
  assert.throws(() => RoutePlanning.acceptPreview(command, raw([zone], { totalRoutes: 3 })), /totales/);
  assert.throws(() => RoutePlanning.acceptPreview(command, raw([zone], { availableCouriers: -1 })), /repartidores/);
  assert.throws(() => RoutePlanning.acceptPreview(command, null), /objeto/);
});

test('el caso de uso valida antes de consultar y entrega el resultado validado', async () => {
  let calls = 0;
  const repository = { previewPlan: async () => { calls += 1; return raw([zone]); } } as unknown as RouteRepository;
  const useCase = new PreviewRoutesUseCase(repository, () => TODAY);
  await assert.rejects(() => useCase.execute({ serviceDate: '2020-01-01', capacityLimit: 4 }), /fecha pasada/);
  assert.equal(calls, 0);
  const result = await useCase.execute({ serviceDate: '2026-11-25', capacityLimit: 4 });
  assert.equal(result.totalRoutes, 2);
  assert.equal(calls, 1);
});

test('pedido del administrador: el pin va con las dos coordenadas, dentro de Ecuador', () => {
  const base = { zoneId: ZONE, deliveryAddress: 'Av. Cevallos 1', deliveryDate: '2026-11-25', deliveryTime: '10:00' };
  assert.equal(Order.prepare(base).latitude ?? null, null);
  assert.deepEqual(Order.validatePin(-1.2491, -78.6167), { latitude: -1.2491, longitude: -78.6167 });
  assert.deepEqual(Order.validatePin(null, undefined), { latitude: null, longitude: null });
  assert.throws(() => Order.validatePin(-1.25, null), /juntas/);
  assert.throws(() => Order.validatePin('-1.25', '-78.6'), /números/);
  assert.throws(() => Order.validatePin(Number.NaN, -78.6), /números/);
  assert.throws(() => Order.validatePin(40.4, -3.7), /dentro de Ecuador/);
  assert.equal(Order.prepare({ ...base, latitude: -1.25, longitude: -78.61 }).longitude, -78.61);
});

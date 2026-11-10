import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createRoutesApp } from '../../../src/bootstrap/sprint02/routes.server.js';
import { createDatabaseClient } from '../../../src/bootstrap/database.js';
import {
  activeStopsPerOrder,
  closeRoutesDatabase,
  countOrders,
  countRoutes,
  createCourier,
  createOrder,
  createZone,
  guayaquilDate,
  orderStatuses,
  realDatabase,
  resetOperationsData,
  routeWithOrders,
  routesDatabase,
  setCourierAvailability,
  startRoute,
} from './route-operations.fixture.js';

// Accepted only against real PostgreSQL through HTTP; without the harness the suite is reported as skipped.
const describeReal = realDatabase ? describe : describe.skip;
const WEB_ORIGIN = 'http://127.0.0.1:5173';
const TIMEOUT = 60_000;

type App = ReturnType<typeof createRoutesApp>;
interface RouteSnapshot {
  id: string; zoneId: string; serviceDate: string; capacityLimit: number; status: string;
  courierId: string | null; occupiedSlots: number;
  stops: Array<{ orderId: string; position: number; status: string }>;
}

function expectErrorEnvelope(body: Record<string, unknown>, code: string): void {
  expect(body['code']).toBe(code);
  expect(typeof body['message']).toBe('string');
  expect(body['error']).toEqual({ code, message: body['message'] });
  // No SQLSTATE, SQL text or driver details in any error.
  expect(JSON.stringify(body)).not.toMatch(/\b(?:2[0-9A-Z]{4}|4[0-9A-Z]{4}|55P03|P0002)\b|logistica\.|SELECT|postgres/i);
}

async function detail(app: App, id: string): Promise<RouteSnapshot> {
  const response = await request(app).get(`/routes/${id}`);
  expect(response.status).toBe(200);
  return response.body as RouteSnapshot;
}

function stopIds(route: RouteSnapshot): string[] {
  return route.stops.map((stop) => stop.orderId);
}

async function expectNoDuplicatedOrders(): Promise<void> {
  expect((await activeStopsPerOrder()).every((row) => row.total === 1)).toBe(true);
}

describeReal('Sprint 03 · Route operations · S3-CP-001 ajustes manuales (mover y reordenar)', () => {
  let app: App;
  const day = guayaquilDate(2);
  const otherDay = guayaquilDate(3);

  beforeEach(async () => {
    await resetOperationsData();
    app = createRoutesApp(routesDatabase(), WEB_ORIGIN);
  }, TIMEOUT);

  afterAll(closeRoutesDatabase);

  // Two compatible routes before departure plus incompatible / full destinations, all from original functions.
  async function prepareRoutes() {
    const zoneA = await createZone('Centro S3');
    const zoneB = await createZone('Norte S3');
    const a = [] as string[];
    for (const [index, time] of ['08:00', '09:00', '10:00', '11:00', '12:00'].entries()) {
      a.push(await createOrder(zoneA, `Calle A${index + 1}`, day, time));
    }
    const pending = await createOrder(zoneA, 'Calle A pendiente', day, '13:00');
    const b1 = await createOrder(zoneB, 'Calle B1', day, '09:00');
    const x1 = await createOrder(zoneA, 'Calle A otro día', otherDay, '09:00');
    const source = await routeWithOrders(zoneA, day, 3, [a[0]!, a[1]!, a[2]!]);
    const destination = await routeWithOrders(zoneA, day, 2, [a[3]!]);
    const full = await routeWithOrders(zoneA, day, 1, [a[4]!]);
    const otherZone = await routeWithOrders(zoneB, day, 3, [b1]);
    const otherDate = await routeWithOrders(zoneA, otherDay, 3, [x1]);
    return { zoneA, a, pending, b1, x1, source, destination, full, otherZone, otherDate };
  }

  it('mueve un pedido a una ruta compatible: queda al final del destino, sale del origen y no se duplica', async () => {
    const s = await prepareRoutes();
    const response = await request(app).post('/route-moves').send({ orderId: s.a[0], destinationRouteId: s.destination });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ orderId: s.a[0], routeId: s.destination });

    const source = await detail(app, s.source);
    const destination = await detail(app, s.destination);
    expect(stopIds(source)).toEqual([s.a[1], s.a[2]]);
    expect(source.occupiedSlots).toBe(2);
    expect(stopIds(destination)).toEqual([s.a[3], s.a[0]]);
    expect(destination.stops.map((stop) => stop.position)).toEqual([1, 2]);
    expect(destination.occupiedSlots).toBeLessThanOrEqual(destination.capacityLimit);
    expect((await orderStatuses([s.a[0]!])).get(s.a[0]!)).toBe('asignado_a_ruta');
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('reordena con la lista completa; la misma lista produce el mismo orden observable', async () => {
    const s = await prepareRoutes();
    const desired = [s.a[2]!, s.a[0]!, s.a[1]!];
    const first = await request(app).put(`/routes/${s.source}/stop-order`).send({ orderIds: desired });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ routeId: s.source, orderIds: desired });
    const afterFirst = await detail(app, s.source);
    expect(stopIds(afterFirst)).toEqual(desired);
    expect(afterFirst.stops.map((stop) => stop.position)).toEqual([1, 2, 3]);

    const second = await request(app).put(`/routes/${s.source}/stop-order`).send({ orderIds: desired });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(stopIds(await detail(app, s.source))).toEqual(desired);
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('rechaza zona, fecha o cupo incompatibles, la misma ruta y un pedido sin ruta, sin cambios parciales', async () => {
    const s = await prepareRoutes();
    const routes = [s.source, s.destination, s.full, s.otherZone, s.otherDate];
    const before = await Promise.all(routes.map((id) => detail(app, id)));

    const attempts = [
      { orderId: s.a[1], destinationRouteId: s.otherZone },
      { orderId: s.a[1], destinationRouteId: s.otherDate },
      { orderId: s.a[1], destinationRouteId: s.full },
      { orderId: s.a[1], destinationRouteId: s.source },
      { orderId: s.pending, destinationRouteId: s.destination },
    ];
    for (const body of attempts) {
      const response = await request(app).post('/route-moves').send(body);
      expect(response.status).toBe(409);
      expectErrorEnvelope(response.body, 'DATA_CONFLICT');
    }

    expect(await Promise.all(routes.map((id) => detail(app, id)))).toEqual(before);
    expect((await orderStatuses([s.pending])).get(s.pending)).toBe('pendiente');
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('rechaza un reordenamiento que no coincide con las paradas vigentes, sin cambios', async () => {
    const s = await prepareRoutes();
    const before = await detail(app, s.source);
    for (const orderIds of [
      [s.a[0], s.a[1]],
      [s.a[0], s.a[1], s.a[2], s.a[3]],
      [s.a[0], s.a[1], s.a[3]],
    ]) {
      const response = await request(app).put(`/routes/${s.source}/stop-order`).send({ orderIds });
      expect(response.status).toBe(409);
      expectErrorEnvelope(response.body, 'DATA_CONFLICT');
    }
    expect(await detail(app, s.source)).toEqual(before);
  }, TIMEOUT);

  it('no permite modificar una ruta iniciada: ni sacar, ni meter, ni reordenar pedidos', async () => {
    const s = await prepareRoutes();
    const started = await routeWithOrders(s.zoneA, day, 3, [
      await createOrder(s.zoneA, 'Salida 1', day, '07:00'),
      await createOrder(s.zoneA, 'Salida 2', day, '07:30'),
    ]);
    const startedBefore = await detail(app, started);
    await startRoute(started, startedBefore.stops[0]!.orderId);
    const startedRoute = await detail(app, started);
    expect(startedRoute.status).toBe('en_curso');
    const waiting = startedRoute.stops[1]!.orderId;
    const sourceBefore = await detail(app, s.source);
    const destinationBefore = await detail(app, s.destination);

    const out = await request(app).post('/route-moves').send({ orderId: waiting, destinationRouteId: s.destination });
    expect(out.status).toBe(409);
    expectErrorEnvelope(out.body, 'DATA_CONFLICT');
    const into = await request(app).post('/route-moves').send({ orderId: s.a[1], destinationRouteId: started });
    expect(into.status).toBe(409);
    expectErrorEnvelope(into.body, 'DATA_CONFLICT');
    const reorder = await request(app).put(`/routes/${started}/stop-order`).send({ orderIds: [...stopIds(startedRoute)].reverse() });
    expect(reorder.status).toBe(409);
    expectErrorEnvelope(reorder.body, 'DATA_CONFLICT');

    expect(await detail(app, started)).toEqual(startedRoute);
    expect(await detail(app, s.source)).toEqual(sourceBefore);
    expect(await detail(app, s.destination)).toEqual(destinationBefore);
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('dos movimientos simultáneos al último cupo: uno se confirma, el otro se rechaza y no se supera la capacidad', async () => {
    const s = await prepareRoutes();
    const [first, second] = await Promise.all([
      request(app).post('/route-moves').send({ orderId: s.a[0], destinationRouteId: s.destination }),
      request(app).post('/route-moves').send({ orderId: s.a[1], destinationRouteId: s.destination }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const destination = await detail(app, s.destination);
    expect(destination.occupiedSlots).toBe(2);
    expect(destination.occupiedSlots).toBeLessThanOrEqual(destination.capacityLimit);
    expect((await detail(app, s.source)).occupiedSlots).toBe(2);
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('pedido o ruta inexistente responde 404 con el código correspondiente', async () => {
    const s = await prepareRoutes();
    const missingOrder = await request(app).post('/route-moves').send({ orderId: randomUUID(), destinationRouteId: s.destination });
    expect(missingOrder.status).toBe(404);
    expectErrorEnvelope(missingOrder.body, 'ORDER_NOT_FOUND');
    const missingRoute = await request(app).post('/route-moves').send({ orderId: s.a[0], destinationRouteId: randomUUID() });
    expect(missingRoute.status).toBe(404);
    expectErrorEnvelope(missingRoute.body, 'ROUTE_NOT_FOUND');
    const missingReorder = await request(app).put(`/routes/${randomUUID()}/stop-order`).send({ orderIds: [s.a[0]] });
    expect(missingReorder.status).toBe(404);
    expectErrorEnvelope(missingReorder.body, 'ROUTE_NOT_FOUND');
  }, TIMEOUT);

  it('entradas inválidas responden 400 VALIDATION_ERROR sin tocar la base', async () => {
    const s = await prepareRoutes();
    const before = await detail(app, s.source);
    const moves: unknown[] = [
      {}, { orderId: s.a[0] }, { orderId: 'x', destinationRouteId: s.destination },
      { orderId: s.a[0], destinationRouteId: 42 }, [s.a[0], s.destination],
    ];
    for (const body of moves) {
      const response = await request(app).post('/route-moves').send(body as object);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_ERROR');
    }
    const reorders: Array<{ path: string; body: unknown }> = [
      { path: s.source, body: {} },
      { path: s.source, body: { orderIds: [] } },
      { path: s.source, body: { orderIds: [s.a[0], s.a[0], s.a[1]] } },
      { path: s.source, body: { orderIds: [1, 2, 3] } },
      { path: s.source, body: { orderIds: s.a[0] } },
      { path: 'no-es-uuid', body: { orderIds: [s.a[0]] } },
    ];
    for (const { path, body } of reorders) {
      const response = await request(app).put(`/routes/${path}/stop-order`).send(body as object);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_ERROR');
    }
    const malformed = await request(app).post('/route-moves').set('Content-Type', 'application/json').send('{"orderId":');
    expect(malformed.status).toBe(400);
    expectErrorEnvelope(malformed.body, 'VALIDATION_ERROR');
    const large = await request(app).post('/route-moves').send({ orderId: s.a[0], destinationRouteId: s.destination, filler: 'x'.repeat(40_000) });
    expect(large.status).toBe(413);
    expectErrorEnvelope(large.body, 'VALIDATION_ERROR');
    expect(await detail(app, s.source)).toEqual(before);
  }, TIMEOUT);

  it('conserva los endpoints S2 en la misma entrada (planificar, listar, detalle)', async () => {
    const zone = await createZone('Regresión S2');
    await createOrder(zone, 'Pendiente S2', otherDay, '10:00');
    const plan = await request(app).post('/route-plans').set('Idempotency-Key', randomUUID())
      .send({ serviceDate: otherDay, capacityLimit: 4 });
    expect(plan.status).toBe(200);
    expect(plan.body.routeIds).toHaveLength(1);
    const list = await request(app).get('/routes').query({ serviceDate: otherDay, zoneId: zone });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect((await detail(app, plan.body.routeIds[0])).stops).toHaveLength(1);
  }, TIMEOUT);
});

describeReal('Sprint 03 · Route operations · S3-CP-002 pedidos de último momento', () => {
  let app: App;
  const today = guayaquilDate(0);

  beforeEach(async () => {
    await resetOperationsData();
    app = createRoutesApp(routesDatabase(), WEB_ORIGIN);
  }, TIMEOUT);

  afterAll(closeRoutesDatabase);

  function place(orderId: unknown, capacityLimit: unknown, key: string | undefined) {
    const call = request(app).post('/late-order-placements');
    return (key === undefined ? call : call.set('Idempotency-Key', key)).send({ orderId, capacityLimit });
  }

  async function lateScenario() {
    const zone = await createZone('Último momento');
    const planned = await createOrder(zone, 'Planificado', today, '18:00');
    const late = await createOrder(zone, 'Último momento', today, '20:00');
    return { zone, planned, late };
  }

  it('inserta en una ruta compatible con cupo; repetir clave/payload devuelve la misma respuesta', async () => {
    const s = await lateScenario();
    const route = await routeWithOrders(s.zone, today, 2, [s.planned]);
    const routesBefore = await countRoutes();
    const key = randomUUID();

    const first = await place(s.late, 4, key);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ orderId: s.late, status: 'asignado_a_ruta', routeId: route });
    const placed = await detail(app, route);
    expect(stopIds(placed)).toEqual([s.planned, s.late]);
    expect(placed.occupiedSlots).toBeLessThanOrEqual(placed.capacityLimit);

    const replay = await place(s.late, 4, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await countRoutes()).toBe(routesBefore);
    expect(stopIds(await detail(app, route))).toEqual([s.planned, s.late]);
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('sin cupo y con repartidor disponible crea una ruta nueva y la asigna, sin superar cupos', async () => {
    const s = await lateScenario();
    const fullRoute = await routeWithOrders(s.zone, today, 1, [s.planned]);
    const courier = await createCourier('Repartidor S3', 3, true);
    const routesBefore = await countRoutes();
    const key = randomUUID();

    const response = await place(s.late, 4, key);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('asignado_a_ruta');
    expect(response.body.routeId).not.toBe(fullRoute);
    const created = await detail(app, response.body.routeId as string);
    expect(created).toMatchObject({ zoneId: s.zone, serviceDate: today, status: 'asignada', courierId: courier, capacityLimit: 3 });
    expect(stopIds(created)).toEqual([s.late]);
    expect((await detail(app, fullRoute)).occupiedSlots).toBe(1);
    expect(await countRoutes()).toBe(routesBefore + 1);

    const replay = await place(s.late, 4, key);
    expect(replay.body).toEqual(response.body);
    expect(await countRoutes()).toBe(routesBefore + 1);
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('sin alternativa queda pendiente con NO_AVAILABLE_COURIER; el replay es estable y un intento nuevo usa clave nueva', async () => {
    const s = await lateScenario();
    await routeWithOrders(s.zone, today, 1, [s.planned]);
    const ordersBefore = await countOrders();
    const routesBefore = await countRoutes();
    const key = randomUUID();

    const waiting = await place(s.late, 4, key);
    expect(waiting.status).toBe(200);
    expect(waiting.body).toEqual({ orderId: s.late, status: 'pendiente', reason: 'NO_AVAILABLE_COURIER' });
    expect((await orderStatuses([s.late])).get(s.late)).toBe('pendiente');
    expect(await countRoutes()).toBe(routesBefore);

    // A new resource appears: the same key/payload still returns the stored answer.
    const courier = await createCourier('Llega tarde', 2, false);
    await setCourierAvailability(courier, true);
    const replay = await place(s.late, 4, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(waiting.body);
    expect((await orderStatuses([s.late])).get(s.late)).toBe('pendiente');

    // A new attempt requires a new key and never registers another order.
    const retry = await place(s.late, 4, randomUUID());
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ orderId: s.late, status: 'asignado_a_ruta' });
    expect((await detail(app, retry.body.routeId as string)).courierId).toBe(courier);
    expect(await countOrders()).toBe(ordersBefore);
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('misma clave con otro payload, pedido ya asignado y pedido inexistente se rechazan sin cambios', async () => {
    const s = await lateScenario();
    const route = await routeWithOrders(s.zone, today, 3, [s.planned]);
    const key = randomUUID();
    expect((await place(s.late, 4, key)).status).toBe(200);
    const before = await detail(app, route);

    const otherPayload = await place(s.late, 5, key);
    expect(otherPayload.status).toBe(409);
    expectErrorEnvelope(otherPayload.body, 'DATA_CONFLICT');
    const alreadyAssigned = await place(s.planned, 4, randomUUID());
    expect(alreadyAssigned.status).toBe(409);
    expectErrorEnvelope(alreadyAssigned.body, 'DATA_CONFLICT');
    const missing = await place(randomUUID(), 4, randomUUID());
    expect(missing.status).toBe(404);
    expectErrorEnvelope(missing.body, 'ORDER_NOT_FOUND');
    expect(await detail(app, route)).toEqual(before);
  }, TIMEOUT);

  it('dos pedidos tardíos simultáneos con un solo cupo: uno entra, el otro espera y no se supera la capacidad', async () => {
    const s = await lateScenario();
    const second = await createOrder(s.zone, 'Último momento 2', today, '20:30');
    const route = await routeWithOrders(s.zone, today, 2, [s.planned]);
    const [left, right] = await Promise.all([place(s.late, 4, randomUUID()), place(second, 4, randomUUID())]);
    expect([left.status, right.status]).toEqual([200, 200]);
    expect([left.body.status, right.body.status].sort()).toEqual(['asignado_a_ruta', 'pendiente']);
    const after = await detail(app, route);
    expect(after.occupiedSlots).toBe(2);
    expect(after.occupiedSlots).toBeLessThanOrEqual(after.capacityLimit);
    await expectNoDuplicatedOrders();
  }, TIMEOUT);

  it('entradas inválidas responden 400 sin registrar la operación', async () => {
    const s = await lateScenario();
    const cases: Array<{ orderId: unknown; capacityLimit: unknown; key: string | undefined }> = [
      { orderId: s.late, capacityLimit: 4, key: undefined },
      { orderId: s.late, capacityLimit: 4, key: 'no-es-uuid' },
      { orderId: s.late, capacityLimit: '4', key: randomUUID() },
      { orderId: s.late, capacityLimit: 0, key: randomUUID() },
      { orderId: s.late, capacityLimit: 1.5, key: randomUUID() },
      { orderId: undefined, capacityLimit: 4, key: randomUUID() },
      { orderId: 'x', capacityLimit: 4, key: randomUUID() },
    ];
    for (const item of cases) {
      const response = await place(item.orderId, item.capacityLimit, item.key);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_ERROR');
    }
    expect((await orderStatuses([s.late])).get(s.late)).toBe('pendiente');
  }, TIMEOUT);

  it('una base inaccesible responde 503 sin detalles; en el movimiento indica consultar antes de reintentar', async () => {
    const unreachable = createDatabaseClient('postgresql://logistica_app:invalid@127.0.0.1:1/logistica_test');
    try {
      const offline = createRoutesApp(unreachable, WEB_ORIGIN);
      const move = await request(offline).post('/route-moves').send({ orderId: randomUUID(), destinationRouteId: randomUUID() });
      expect(move.status).toBe(503);
      expectErrorEnvelope(move.body, 'PERSISTENCE_UNAVAILABLE');
      expect(move.body.message).toMatch(/consulta/i);
      const reorder = await request(offline).put(`/routes/${randomUUID()}/stop-order`).send({ orderIds: [randomUUID()] });
      expect(reorder.status).toBe(503);
      expectErrorEnvelope(reorder.body, 'PERSISTENCE_UNAVAILABLE');
      const late = await request(offline).post('/late-order-placements').set('Idempotency-Key', randomUUID())
        .send({ orderId: randomUUID(), capacityLimit: 4 });
      expect(late.status).toBe(503);
      expectErrorEnvelope(late.body, 'PERSISTENCE_UNAVAILABLE');
    } finally {
      await unreachable.$disconnect();
    }
  }, TIMEOUT);
});

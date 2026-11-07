import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createRoutesApp } from '../../../src/bootstrap/sprint02/routes.server.js';
import { createDatabaseClient } from '../../../src/bootstrap/database.js';
import {
  activeStopsPerOrder,
  closeRoutesDatabase,
  countRoutes,
  createOrder,
  createZone,
  deactivateZone,
  guayaquilDate,
  orderStatuses,
  realDatabase,
  resetRoutesData,
  routesDatabase,
} from './routes.fixture.js';

// Routes is accepted only against real PostgreSQL; without the harness the suite is reported as skipped.
const describeReal = realDatabase ? describe : describe.skip;
const WEB_ORIGIN = 'http://127.0.0.1:5173';

interface RouteBody {
  id: string; zoneId: string; serviceDate: string; capacityLimit: number;
  status: string; courierId: string | null; occupiedSlots: number;
}
interface StopBody {
  orderId: string; position: number; deliveryAddress: string; deliveryDate: string; deliveryTime: string; status: string;
}

function expectErrorEnvelope(body: Record<string, unknown>, code: string): void {
  expect(body['code']).toBe(code);
  expect(typeof body['message']).toBe('string');
  expect(body['error']).toEqual({ code, message: body['message'] });
  // No SQLSTATE, SQL text or driver details in any error.
  expect(JSON.stringify(body)).not.toMatch(/\b(?:2[0-9A-Z]{4}|4[0-9A-Z]{4}|55P03)\b|logistica\.|SELECT|postgres/i);
}

describeReal('Sprint 02 · Routes · S2-CP-001 agrupación por zona/fecha y capacidad', () => {
  let app: ReturnType<typeof createRoutesApp>;
  const planDay = guayaquilDate(3);
  const otherDay = guayaquilDate(4);

  beforeEach(() => {
    resetRoutesData();
    app = createRoutesApp(routesDatabase(), WEB_ORIGIN);
  });

  afterAll(closeRoutesDatabase);

  async function plan(serviceDate: string, capacityLimit: unknown, key: string) {
    return request(app).post('/route-plans').set('Idempotency-Key', key).send({ serviceDate, capacityLimit });
  }

  async function detail(id: string): Promise<RouteBody & { stops: StopBody[] }> {
    const response = await request(app).get(`/routes/${id}`);
    expect(response.status).toBe(200);
    return response.body as RouteBody & { stops: StopBody[] };
  }

  async function prepareScenario() {
    const zoneA = await createZone('Centro S2');
    const zoneB = await createZone('Norte S2');
    // Five pending orders of the same group (zone A, plan day) inserted out of time order.
    const timesA = ['09:00', '08:00', '10:00', '08:30', '11:00'];
    const ordersA: Array<{ id: string; time: string }> = [];
    for (const [index, time] of timesA.entries()) {
      ordersA.push({ id: await createOrder(zoneA, `Calle A${index + 1}`, planDay, time), time });
    }
    const ordersB = [
      await createOrder(zoneB, 'Calle B1', planDay, '12:00'),
      await createOrder(zoneB, 'Calle B2', planDay, '07:45'),
    ];
    const ordersOtherDay = [
      await createOrder(zoneA, 'Calle A otro día 1', otherDay, '09:00'),
      await createOrder(zoneB, 'Calle B otro día 1', otherDay, '09:00'),
    ];
    return { zoneA, zoneB, ordersA, ordersB, ordersOtherDay };
  }

  it('planifica solo el día solicitado, separa zonas, respeta capacidad 4 (4+1) y no duplica pedidos', async () => {
    const scenario = await prepareScenario();
    const key = randomUUID();

    const response = await plan(planDay, 4, key);
    expect(response.status).toBe(200);
    expect(response.body.serviceDate).toBe(planDay);
    expect(response.body.routeIds).toHaveLength(3);
    expect(new Set(response.body.routeIds).size).toBe(3);

    const routes = await Promise.all((response.body.routeIds as string[]).map(detail));
    for (const route of routes) {
      expect(route).toMatchObject({ serviceDate: planDay, capacityLimit: 4, status: 'planificada', courierId: null });
      expect(route.stops).toHaveLength(route.occupiedSlots);
      expect(route.stops.map((stop) => stop.position)).toEqual(route.stops.map((_stop, index) => index + 1));
      for (const stop of route.stops) {
        expect(stop.deliveryDate).toBe(planDay);
        expect(stop.status).toBe('asignado_a_ruta');
        expect(stop.deliveryTime).toMatch(/^\d{2}:\d{2}$/);
      }
    }

    const routesA = routes.filter((route) => route.zoneId === scenario.zoneA);
    const routesB = routes.filter((route) => route.zoneId === scenario.zoneB);
    expect(routesA.map((route) => route.occupiedSlots).sort()).toEqual([1, 4]);
    expect(routesB.map((route) => route.occupiedSlots)).toEqual([2]);

    // zona_hora_v1: delivery time then ID inside the group; the fifth order opens the second route.
    const byTime = [...scenario.ordersA].sort((left, right) => left.time.localeCompare(right.time));
    const fullRoute = routesA.find((route) => route.occupiedSlots === 4)!;
    const overflowRoute = routesA.find((route) => route.occupiedSlots === 1)!;
    expect(fullRoute.stops.map((stop) => stop.orderId)).toEqual(byTime.slice(0, 4).map((order) => order.id));
    expect(fullRoute.stops.map((stop) => stop.deliveryTime)).toEqual(['08:00', '08:30', '09:00', '10:00']);
    expect(overflowRoute.stops.map((stop) => stop.orderId)).toEqual([byTime[4]!.id]);
    expect(routesB[0]!.stops.map((stop) => stop.deliveryTime)).toEqual(['07:45', '12:00']);

    const plannedOrderIds = routes.flatMap((route) => route.stops.map((stop) => stop.orderId));
    expect(new Set(plannedOrderIds).size).toBe(plannedOrderIds.length);
    expect(new Set(plannedOrderIds)).toEqual(new Set([...scenario.ordersA.map((order) => order.id), ...scenario.ordersB]));
    expect((await activeStopsPerOrder()).every((row) => row.total === 1)).toBe(true);

    // Orders of another day stay pending and receive no route.
    const otherStatuses = await orderStatuses(scenario.ordersOtherDay);
    expect([...otherStatuses.values()]).toEqual(['pendiente', 'pendiente']);
    const otherDayList = await request(app).get('/routes').query({ serviceDate: otherDay });
    expect(otherDayList.status).toBe(200);
    expect(otherDayList.body.items).toEqual([]);
  });

  it('misma clave conserva el resultado y una clave nueva sin pendientes no crea ni duplica rutas', async () => {
    await prepareScenario();
    const key = randomUUID();
    const first = await plan(planDay, 4, key);
    expect(first.status).toBe(200);
    const routesAfterFirst = await countRoutes();
    expect(routesAfterFirst).toBe(3);

    const repeated = await plan(planDay, 4, key);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual(first.body);
    expect(await countRoutes()).toBe(routesAfterFirst);

    const fresh = await plan(planDay, 4, randomUUID());
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({ serviceDate: planDay, routeIds: [] });
    expect(await countRoutes()).toBe(routesAfterFirst);
    expect((await activeStopsPerOrder()).every((row) => row.total === 1)).toBe(true);
  });

  it('misma clave con datos distintos responde 409 DATA_CONFLICT sin cambios', async () => {
    await prepareScenario();
    const key = randomUUID();
    expect((await plan(planDay, 4, key)).status).toBe(200);
    const before = await countRoutes();

    const conflict = await plan(planDay, 2, key);
    expect(conflict.status).toBe(409);
    expectErrorEnvelope(conflict.body, 'DATA_CONFLICT');
    expect(await countRoutes()).toBe(before);
  });

  it('sin pedidos pendientes devuelve routeIds vacío y no crea rutas vacías', async () => {
    await createZone('Zona sin pedidos');
    const response = await plan(planDay, 4, randomUUID());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ serviceDate: planDay, routeIds: [] });
    expect(await countRoutes()).toBe(0);
  });

  it('la capacidad es un parámetro: capacidad 1 crea una ruta por pedido del grupo', async () => {
    const zone = await createZone('Capacidad variable');
    await createOrder(zone, 'Uno', otherDay, '10:00');
    await createOrder(zone, 'Dos', otherDay, '11:00');
    const response = await plan(otherDay, 1, randomUUID());
    expect(response.status).toBe(200);
    expect(response.body.routeIds).toHaveLength(2);
    const routes = await Promise.all((response.body.routeIds as string[]).map(detail));
    expect(routes.map((route) => [route.capacityLimit, route.occupiedSlots])).toEqual([[1, 1], [1, 1]]);
  });

  it('no planifica pedidos de una zona inactiva', async () => {
    const active = await createZone('Activa');
    const inactive = await createZone('Inactiva');
    await createOrder(active, 'Activa 1', planDay, '10:00');
    const blocked = await createOrder(inactive, 'Inactiva 1', planDay, '10:00');
    deactivateZone(inactive);

    const response = await plan(planDay, 4, randomUUID());
    expect(response.status).toBe(200);
    expect(response.body.routeIds).toHaveLength(1);
    expect((await detail(response.body.routeIds[0])).zoneId).toBe(active);
    expect((await orderStatuses([blocked])).get(blocked)).toBe('pendiente');
  });

  it('dos planificaciones simultáneas del mismo día con claves distintas no asignan dos veces un pedido', async () => {
    const scenario = await prepareScenario();
    const [left, right] = await Promise.all([plan(planDay, 4, randomUUID()), plan(planDay, 4, randomUUID())]);
    expect([left.status, right.status]).toEqual([200, 200]);
    const lengths = [left.body.routeIds.length, right.body.routeIds.length].sort();
    expect(lengths).toEqual([0, 3]);
    expect(await countRoutes()).toBe(3);
    const stops = await activeStopsPerOrder();
    expect(stops).toHaveLength(scenario.ordersA.length + scenario.ordersB.length);
    expect(stops.every((row) => row.total === 1)).toBe(true);
  });

  describe('consulta de rutas', () => {
    it('filtra por serviceDate y zoneId con AND, pagina con orden estable por ID', async () => {
      const scenario = await prepareScenario();
      expect((await plan(planDay, 4, randomUUID())).status).toBe(200);
      expect((await plan(otherDay, 4, randomUUID())).status).toBe(200);

      const all = await request(app).get('/routes');
      expect(all.status).toBe(200);
      expect(all.body).toMatchObject({ limit: 25, offset: 0 });
      expect(all.body.items).toHaveLength(5);
      const ids = (all.body.items as RouteBody[]).map((route) => route.id);
      expect(ids).toEqual([...ids].sort());

      const day = await request(app).get('/routes').query({ serviceDate: planDay });
      expect((day.body.items as RouteBody[]).every((route) => route.serviceDate === planDay)).toBe(true);
      expect(day.body.items).toHaveLength(3);

      const both = await request(app).get('/routes').query({ serviceDate: planDay, zoneId: scenario.zoneA });
      expect(both.body.items).toHaveLength(2);
      expect((both.body.items as RouteBody[]).every((route) => route.zoneId === scenario.zoneA && route.serviceDate === planDay)).toBe(true);
      for (const route of both.body.items as RouteBody[]) {
        expect(Object.keys(route).sort()).toEqual(
          ['capacityLimit', 'courierId', 'id', 'occupiedSlots', 'serviceDate', 'status', 'zoneId']
        );
      }

      const firstPage = await request(app).get('/routes').query({ limit: '2', offset: '0' });
      const secondPage = await request(app).get('/routes').query({ limit: '2', offset: '2' });
      const lastPage = await request(app).get('/routes').query({ limit: '2', offset: '4' });
      expect(firstPage.body).toMatchObject({ limit: 2, offset: 0 });
      expect([...firstPage.body.items, ...secondPage.body.items, ...lastPage.body.items].map((route: RouteBody) => route.id)).toEqual(ids);

      const empty = await request(app).get('/routes').query({ offset: '100' });
      expect(empty.status).toBe(200);
      expect(empty.body.items).toEqual([]);
    });

    it('el detalle expone exactamente los campos del contrato y responde 404 para una ruta inexistente', async () => {
      await prepareScenario();
      const planned = await plan(planDay, 4, randomUUID());
      const route = await detail(planned.body.routeIds[0]);
      expect(Object.keys(route).sort()).toEqual(
        ['capacityLimit', 'courierId', 'id', 'occupiedSlots', 'serviceDate', 'status', 'stops', 'zoneId']
      );
      expect(Object.keys(route.stops[0]!).sort()).toEqual(
        ['deliveryAddress', 'deliveryDate', 'deliveryTime', 'orderId', 'position', 'status']
      );

      const missing = await request(app).get(`/routes/${randomUUID()}`);
      expect(missing.status).toBe(404);
      expectErrorEnvelope(missing.body, 'ROUTE_NOT_FOUND');
    });

    it.each([
      ['UUID inválido en detalle', '/routes/no-es-uuid'],
      ['fecha imposible', '/routes?serviceDate=2026-02-30'],
      ['zona inválida', '/routes?zoneId=123'],
      ['limit 0', '/routes?limit=0'],
      ['limit 101', '/routes?limit=101'],
      ['limit no numérico', '/routes?limit=abc'],
      ['offset negativo', '/routes?offset=-1'],
      ['parámetro repetido', `/routes?serviceDate=${guayaquilDate(3)}&serviceDate=${guayaquilDate(4)}`],
      ['parámetro vacío', '/routes?zoneId='],
    ])('rechaza consultas inválidas con 400 VALIDATION_ERROR: %s', async (_name, path) => {
      const response = await request(app).get(path);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_ERROR');
    });
  });

  describe('validación de la planificación', () => {
    it.each([
      ['sin Idempotency-Key', undefined, { serviceDate: guayaquilDate(3), capacityLimit: 4 }],
      ['Idempotency-Key no UUID', 'clave-1', { serviceDate: guayaquilDate(3), capacityLimit: 4 }],
      ['capacidad 0', 'uuid', { serviceDate: guayaquilDate(3), capacityLimit: 0 }],
      ['capacidad negativa', 'uuid', { serviceDate: guayaquilDate(3), capacityLimit: -2 }],
      ['capacidad decimal', 'uuid', { serviceDate: guayaquilDate(3), capacityLimit: 1.5 }],
      ['capacidad como texto', 'uuid', { serviceDate: guayaquilDate(3), capacityLimit: '4' }],
      ['capacidad ausente', 'uuid', { serviceDate: guayaquilDate(3) }],
      ['fecha ausente', 'uuid', { capacityLimit: 4 }],
      ['fecha con formato inválido', 'uuid', { serviceDate: '10/11/2026', capacityLimit: 4 }],
      ['fecha imposible', 'uuid', { serviceDate: '2026-02-30', capacityLimit: 4 }],
      ['cuerpo arreglo', 'uuid', [guayaquilDate(3), 4]],
    ])('rechaza %s con 400 sin crear rutas', async (_name, key, body) => {
      const zone = await createZone('Validación');
      await createOrder(zone, 'Pendiente', guayaquilDate(3), '10:00');
      let call = request(app).post('/route-plans');
      if (key !== undefined) call = call.set('Idempotency-Key', key === 'uuid' ? randomUUID() : key);
      const response = await call.send(body as object);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'VALIDATION_ERROR');
      expect(await countRoutes()).toBe(0);
    });

    it('JSON mal formado responde 400 y un cuerpo mayor a 32 KB responde 413, con el sobre de errores', async () => {
      const malformed = await request(app).post('/route-plans').set('Idempotency-Key', randomUUID())
        .set('Content-Type', 'application/json').send('{"serviceDate":');
      expect(malformed.status).toBe(400);
      expectErrorEnvelope(malformed.body, 'VALIDATION_ERROR');

      const large = await request(app).post('/route-plans').set('Idempotency-Key', randomUUID())
        .send({ serviceDate: guayaquilDate(3), capacityLimit: 4, filler: 'x'.repeat(40_000) });
      expect(large.status).toBe(413);
      expectErrorEnvelope(large.body, 'VALIDATION_ERROR');
    });

    it('ignora campos adicionales del cliente', async () => {
      const zone = await createZone('Extras');
      await createOrder(zone, 'Pendiente', planDay, '10:00');
      const response = await request(app).post('/route-plans').set('Idempotency-Key', randomUUID())
        .send({ serviceDate: planDay, capacityLimit: 4, zoneId: randomUUID(), algorithm: 'otro', routeIds: ['x'] });
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['routeIds', 'serviceDate']);
      expect(response.body.routeIds).toHaveLength(1);
    });
  });

  it('una base inaccesible responde 503 PERSISTENCE_UNAVAILABLE sin detalles técnicos', async () => {
    const unreachable = createDatabaseClient('postgresql://logistica_app:invalid@127.0.0.1:1/logistica_test');
    try {
      const offline = createRoutesApp(unreachable, WEB_ORIGIN);
      const listing = await request(offline).get('/routes');
      expect(listing.status).toBe(503);
      expectErrorEnvelope(listing.body, 'PERSISTENCE_UNAVAILABLE');
      const planning = await request(offline).post('/route-plans').set('Idempotency-Key', randomUUID())
        .send({ serviceDate: planDay, capacityLimit: 4 });
      expect(planning.status).toBe(503);
      expectErrorEnvelope(planning.body, 'PERSISTENCE_UNAVAILABLE');
    } finally {
      await unreachable.$disconnect();
    }
  });
});

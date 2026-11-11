import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { createPersistedApp } from '../../src/bootstrap/create-persisted-app.js';
import { createDatabaseClient } from '../../src/bootstrap/database.js';
import { realDatabase, resetTestData } from './database.fixture.js';

const WEB_ORIGIN = 'http://127.0.0.1:5173';

function expectEnvelope(body: Record<string, unknown>, code: string): void {
  expect(body['code']).toBe(code);
  expect(body['error']).toEqual({ code, message: body['message'] });
}

describe('API unificada · respuestas comunes sin base de datos', () => {
  const app = createApp({ webOrigin: WEB_ORIGIN });

  it('una ruta inexistente responde 404 NOT_FOUND en JSON', async () => {
    const response = await request(app).get('/no-existe');
    expect(response.status).toBe(404);
    expect(response.type).toBe('application/json');
    expectEnvelope(response.body, 'NOT_FOUND');
  });

  it('el preflight CORS permite la cabecera Idempotency-Key solo al origen web', async () => {
    const allowed = await request(app).options('/route-plans').set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type,idempotency-key');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    const foreign = await request(app).options('/route-plans').set('Origin', 'http://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(foreign.status).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('JSON mal formado en cualquier ruta responde 400 con el sobre común', async () => {
    const response = await request(app).post('/cualquier-ruta').set('Content-Type', 'application/json').send('{"a":');
    expect(response.status).toBe(400);
    expectEnvelope(response.body, 'VALIDATION_ERROR');
  });
});

const describeReal = realDatabase ? describe : describe.skip;

describeReal('API unificada · un solo servidor con PostgreSQL real', () => {
  const database = realDatabase ? createDatabaseClient(process.env.TEST_DATABASE_URL!) : undefined;
  const app = database ? createPersistedApp(database, WEB_ORIGIN) : createApp({ webOrigin: WEB_ORIGIN });
  const serviceDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + 3 * 86_400_000));

  beforeEach(() => { resetTestData(); });
  afterAll(async () => { await database?.$disconnect(); });

  it('expone zonas, pedidos, rutas y repartidores en el mismo servidor', async () => {
    for (const path of ['/health', '/zones', '/orders', '/routes', '/couriers']) {
      expect((await request(app).get(path)).status).toBe(200);
    }
    // Entregas expuestas en el mismo servidor (consulta sin id existente responde 404 de dominio)
    const missingDelivery = await request(app).get(`/delivery-orders/${randomUUID()}`);
    expect(missingDelivery.status).toBe(404);
  });

  it('flujo completo: zona → pedidos → planificación → repartidor → asignación → ruta del repartidor', async () => {
    const zone = await request(app).post('/zones').send({ name: 'Zona integración' });
    expect(zone.status).toBe(201);
    for (const time of ['09:00', '10:00']) {
      const order = await request(app).post('/orders')
        .send({ zoneId: zone.body.id, deliveryAddress: `Calle ${time}`, deliveryDate: serviceDate, deliveryTime: time });
      expect(order.status).toBe(201);
    }

    const plan = await request(app).post('/route-plans').set('Idempotency-Key', randomUUID())
      .send({ serviceDate, capacityLimit: 4 });
    expect(plan.status).toBe(200);
    expect(plan.body.routeIds).toHaveLength(1);
    const routeId = plan.body.routeIds[0] as string;

    const courier = await request(app).post('/couriers').send({ displayName: 'Repartidor integración', maxOrdersPerTrip: 4 });
    expect(courier.status).toBe(201);
    expect((await request(app).patch(`/couriers/${courier.body.id}/availability`).send({ isAvailable: true })).status).toBe(200);

    const assignment = await request(app).post('/courier-assignments').send({ routeId, courierId: courier.body.id });
    expect(assignment.status).toBe(200);

    const route = await request(app).get(`/routes/${routeId}`);
    expect(route.status).toBe(200);
    expect(route.body).toMatchObject({ courierId: courier.body.id, occupiedSlots: 2 });

    const courierRoute = await request(app).get(`/couriers/${courier.body.id}/route`);
    expect(courierRoute.status).toBe(200);
    expect(courierRoute.body.item).not.toBeNull();
  });

  it('cada módulo conserva su sobre de errores dentro del servidor unificado', async () => {
    const malformedPlan = await request(app).post('/route-plans').set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/json').send('{"serviceDate":');
    expect(malformedPlan.status).toBe(400);
    expectEnvelope(malformedPlan.body, 'VALIDATION_ERROR');

    const malformedCourier = await request(app).post('/couriers').set('Content-Type', 'application/json').send('{"x":');
    expect(malformedCourier.status).toBe(400);
    expectEnvelope(malformedCourier.body, 'VALIDATION_ERROR');

    const missingRoute = await request(app).get(`/routes/${randomUUID()}`);
    expect(missingRoute.status).toBe(404);
    expectEnvelope(missingRoute.body, 'ROUTE_NOT_FOUND');

    const unknown = await request(app).get('/no-existe');
    expect(unknown.status).toBe(404);
    expectEnvelope(unknown.body, 'NOT_FOUND');
  });
});

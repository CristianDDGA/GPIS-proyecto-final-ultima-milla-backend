import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createPersistedApp } from '../../src/bootstrap/create-persisted-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { realDatabase } from './database.fixture.js';
import {
  createFixtureActor,
  deliveryDatabase,
  prepareAssignedRoute,
  resetTestData,
  serviceDate,
} from './sprint03/deliveries.fixture.js';

const SECRET = 'integration-test-jwt-secret-1234';
const ORIGIN = 'http://127.0.0.1:5173';

// Autorización por dueño (anti IDOR/BOLA) contra PostgreSQL real: cada rol solo ve sus propios datos.
const describeReal = realDatabase ? describe : describe.skip;

describeReal('Autorización por dueño · PostgreSQL real', () => {
  let database: ReturnType<typeof deliveryDatabase>;
  let app: ReturnType<typeof createPersistedApp>;
  const tokens = new HmacJwtTokenService(SECRET);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function createCustomer(label: string): Promise<{ id: string; token: string }> {
    const rows = await database.$queryRaw<Array<{ id: string }>>`
      SELECT logistica.register_app_user(${`cliente-${label}-${randomUUID()}`}::text, ${`${label}-${randomUUID()}@test.com`}::text, 'hash-de-prueba'::text, 'cliente'::text, NULL::text) AS id`;
    const id = rows[0]!.id;
    return { id, token: tokens.sign({ sub: id, role: 'cliente', authSubject: `cliente-${label}`, courierId: null }) };
  }

  function driverToken(userId: string, courierId: string | null): string {
    return tokens.sign({ sub: userId, role: 'repartidor', authSubject: `repartidor-${userId}`, courierId });
  }

  beforeAll(() => {
    database = deliveryDatabase();
    app = createPersistedApp(database, ORIGIN, { jwtSecret: SECRET });
  });
  beforeEach(() => { resetTestData(); });
  afterAll(async () => { await database?.$disconnect(); });

  it('un cliente solo ve y consulta sus propios pedidos', async () => {
    const admin = createFixtureActor('personal');
    const adminToken = tokens.sign({ sub: admin.actorId, role: 'personal', authSubject: admin.authSubject, courierId: null });
    const zone = await request(app).post('/zones').set(bearer(adminToken)).send({ name: 'Zona Propiedad' });
    expect(zone.status).toBe(201);
    // Una zona solo recibe pedidos si tiene cobertura definida en el mapa.
    expect((await request(app).put(`/zones/${zone.body.id}/coverage`).set(bearer(adminToken)).send({ coverage: { latitude: -0.1807, longitude: -78.4678, radiusKm: 5 } })).status).toBe(200);

    const ana = await createCustomer('ana');
    const luis = await createCustomer('luis');
    const order = (token: string, address: string) => request(app).post('/orders').set(bearer(token))
      .send({ zoneId: zone.body.id, deliveryAddress: address, deliveryDate: serviceDate, deliveryTime: '10:00' });
    const anaOrder = await order(ana.token, 'Calle Ana 123');
    const luisOrder = await order(luis.token, 'Calle Luis 456');
    expect(anaOrder.status).toBe(201);
    expect(luisOrder.status).toBe(201);

    const anaList = await request(app).get('/orders').set(bearer(ana.token));
    expect(anaList.status).toBe(200);
    expect(anaList.body.items.map((item: { id: string }) => item.id)).toEqual([anaOrder.body.id]);

    expect((await request(app).get(`/orders/${anaOrder.body.id}`).set(bearer(ana.token))).status).toBe(200);
    const foreign = await request(app).get(`/orders/${luisOrder.body.id}`).set(bearer(ana.token));
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain('Calle Luis');

    const adminList = await request(app).get('/orders').set(bearer(adminToken));
    expect(adminList.body.items.map((item: { id: string }) => item.id).sort()).toEqual([anaOrder.body.id, luisOrder.body.id].sort());
  });

  it('un repartidor solo ve su propia ruta y los pedidos de esa ruta', async () => {
    const userA = createFixtureActor('repartidor');
    const userB = createFixtureActor('repartidor');
    const routeA = await prepareAssignedRoute(database, { courierUserId: userA.actorId });
    const routeB = await prepareAssignedRoute(database, { courierUserId: userB.actorId });
    const tokenA = driverToken(userA.actorId, routeA.courierId);
    const admin = createFixtureActor('personal');
    const adminToken = tokens.sign({ sub: admin.actorId, role: 'personal', authSubject: admin.authSubject, courierId: null });

    const routes = await request(app).get('/routes').set(bearer(tokenA));
    expect(routes.status).toBe(200);
    expect(routes.body.items.map((item: { id: string }) => item.id)).toEqual([routeA.routeId]);

    expect((await request(app).get(`/routes/${routeA.routeId}`).set(bearer(tokenA))).status).toBe(200);
    const foreignRoute = await request(app).get(`/routes/${routeB.routeId}`).set(bearer(tokenA));
    expect(foreignRoute.status).toBe(404);

    const orders = await request(app).get('/orders').set(bearer(tokenA));
    expect(orders.status).toBe(200);
    expect(orders.body.items.map((item: { id: string }) => item.id).sort()).toEqual([...routeA.orderIds].sort());
    expect((await request(app).get(`/orders/${routeA.orderIds[0]}`).set(bearer(tokenA))).status).toBe(200);
    expect((await request(app).get(`/orders/${routeB.orderIds[0]}`).set(bearer(tokenA))).status).toBe(404);

    // El administrador sigue viendo todo.
    expect((await request(app).get(`/routes/${routeB.routeId}`).set(bearer(adminToken))).status).toBe(200);
    const all = await request(app).get('/orders').set(bearer(adminToken));
    expect(all.body.items).toHaveLength(routeA.orderIds.length + routeB.orderIds.length);
  });

  it('un repartidor sin repartidor vinculado no ve rutas ni pedidos', async () => {
    const user = createFixtureActor('repartidor');
    await prepareAssignedRoute(database, { courierUserId: createFixtureActor('repartidor').actorId });
    const token = driverToken(user.actorId, null);
    expect((await request(app).get('/routes').set(bearer(token))).body.items).toEqual([]);
    expect((await request(app).get('/orders').set(bearer(token))).body.items).toEqual([]);
  });
});

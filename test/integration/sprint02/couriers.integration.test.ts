import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createCouriersApp } from '../../../src/bootstrap/sprint02/couriers.server.js';
import { PrismaCourierRepository } from '../../../src/modules/couriers/infrastructure/postgres/prisma-courier.repository.js';
import { PrismaAssignmentRepository } from '../../../src/modules/couriers/infrastructure/postgres/prisma-assignment.repository.js';
import { courierDatabase, preparedRoute, resetTestData, routeSnapshot, disableCourier, serviceDate, type FixtureDatabase } from './couriers.fixture.js';

describe('Sprint 02 - Couriers - PostgreSQL real (sin mocks)', () => {
  let database: FixtureDatabase;
  let secondDatabase: FixtureDatabase;
  let app: ReturnType<typeof createCouriersApp>;
  let secondApp: ReturnType<typeof createCouriersApp>;
  function application(db: FixtureDatabase) {
    return createCouriersApp({ couriers: new PrismaCourierRepository(db), assignments: new PrismaAssignmentRepository(db), webOrigin: 'http://localhost:5173' });
  }
  beforeAll(() => {
    database = courierDatabase(); secondDatabase = courierDatabase();
    app = application(database); secondApp = application(secondDatabase);
  });
  beforeEach(() => { resetTestData(); });
  afterAll(async () => { await database?.$disconnect(); await secondDatabase?.$disconnect(); });
  async function courier(capacity = 4, available = true) {
    const response = await request(app).post('/couriers').send({ displayName: 'Repartidor sintético', maxOrdersPerTrip: capacity });
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    if (available) expect((await request(app).patch(`/couriers/${id}/availability`).send({ isAvailable: true })).status).toBe(200);
    return id;
  }
  describe('S2-CP-002 - alta, disponibilidad y elegibilidad', () => {
    it('persiste alta inicialmente no disponible y admite nombre repetido', async () => {
      const id = await courier(3, false); const other = await courier(3, false);
      expect(other).not.toBe(id);
      const page = await request(app).get('/couriers');
      expect(page.status).toBe(200); expect(page.body.limit).toBe(25); expect(page.body.offset).toBe(0);
      expect(page.body.items).toHaveLength(2);
      expect(page.body.items.map((item: { id: string }) => item.id)).toEqual([id, other].sort());
      expect(page.body.items[0]).toEqual(expect.objectContaining({ displayName: 'Repartidor sintético', maxOrdersPerTrip: 3, isEnabled: true, isAvailable: false, createdAt: expect.stringMatching(/Z$/), updatedAt: expect.stringMatching(/Z$/) }));
      const stored = await database.$queryRaw<{ n: number }[]>`SELECT count(*)::integer AS n FROM logistica.couriers`;
      expect(stored[0]!.n).toBe(2);
      expect((await request(app).get(`/couriers/${id}/route`)).body).toEqual({ item: null });
    });
    it.each([{}, { displayName: '  ', maxOrdersPerTrip: 1 }, { displayName: 7, maxOrdersPerTrip: 1 }, { displayName: 'X', maxOrdersPerTrip: 0 }, { displayName: 'X', maxOrdersPerTrip: 1.5 }, { displayName: 'X', maxOrdersPerTrip: '2' }, { displayName: 'X', maxOrdersPerTrip: 2147483648 }, null, []])('rechaza alta inválida %j sin insertar', async input => {
      const response = await request(app).post('/couriers').set('Content-Type', 'application/json').send(JSON.stringify(input));
      expect(response.status).toBe(400); expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect((await request(app).get('/couriers')).body.items).toEqual([]);
    });
    it('filtra elegibilidad y pagina; la bandera disponible no libera reserva', async () => {
      const eligible = await courier(); const unavailable = await courier(4, false); const disabled = await courier(); disableCourier(disabled);
      const reserved = await courier(); const route = await preparedRoute(database);
      expect((await request(app).post('/courier-assignments').send({ routeId: route.routeId, courierId: reserved })).status).toBe(200);
      expect((await request(app).patch(`/couriers/${reserved}/availability`).send({ isAvailable: true })).status).toBe(200);
      const yes = await request(app).get('/couriers?available=true');
      expect(yes.body.items.map((item: { id: string }) => item.id)).toEqual([eligible]);
      const no = await request(app).get('/couriers?available=false');
      expect(no.body.items.map((item: { id: string }) => item.id)).toEqual([unavailable, disabled, reserved].sort());
      const page = await request(app).get('/couriers?limit=1&offset=1');
      expect(page.body.items.map((item: { id: string }) => item.id)).toEqual([eligible, unavailable, disabled, reserved].sort().slice(1, 2));
      expect(page.body).toEqual(expect.objectContaining({ limit: 1, offset: 1 }));
      expect((await request(app).get('/couriers?offset=100')).body.items).toEqual([]);
    });
    it.each(['available=1', 'available=true&available=false', 'limit=0', 'limit=101', 'limit=2.5', 'offset=-1', 'offset=2147483648'])('valida query %s', async query => {
      expect((await request(app).get(`/couriers?${query}`)).status).toBe(400);
    });
    it('valida disponibilidad, UUID, JSON malformado y tamaño', async () => {
      const id = await courier();
      for (const payload of [{}, { isAvailable: 'true' }, null, []]) {
        expect((await request(app).patch(`/couriers/${id}/availability`).set('Content-Type', 'application/json').send(JSON.stringify(payload))).status).toBe(400);
      }
      expect((await request(app).patch('/couriers/invalid/availability').send({ isAvailable: true })).status).toBe(400);
      expect((await request(app).get('/couriers/invalid/route')).status).toBe(400);
      const missing = await request(app).patch(`/couriers/${randomUUID()}/availability`).send({ isAvailable: true });
      expect(missing.status).toBe(404); expect(missing.body.code).toBe('COURIER_NOT_FOUND');
      expect((await request(app).get(`/couriers/${randomUUID()}/route`)).status).toBe(404);
      const malformed = await request(app).post('/couriers').set('Content-Type', 'application/json').send('{');
      expect(malformed.status).toBe(400); expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
      const large = await request(app).post('/couriers').send({ displayName: 'x'.repeat(33000), maxOrdersPerTrip: 1 });
      expect(large.status).toBe(413); expect(large.body.code).toBe('VALIDATION_ERROR');
      expect((await request(app).patch(`/couriers/${id}/availability`).send({ isAvailable: false })).body.isAvailable).toBe(false);
    });
  });
  describe('S2-CP-003 - asignación atómica, capacidad y concurrencia', () => {
    it('asigna y devuelve proyección propia con fecha, hora y posiciones', async () => {
      const id = await courier(2); const route = await preparedRoute(database, 2);
      const response = await request(app).post('/courier-assignments').send({ routeId: route.routeId, courierId: id });
      expect(response.status).toBe(200); expect(response.body).toEqual({ routeId: route.routeId, courierId: id, status: 'asignada' });
      const result = await request(app).get(`/couriers/${id}/route`);
      expect(result.status).toBe(200);
      expect(result.body.item).toEqual({ routeId: route.routeId, zoneId: route.zoneId, serviceDate, status: 'asignada', stops: route.orderIds.map((orderId, index) => ({ orderId, position: index + 1, deliveryAddress: 'Dirección sintética S2', deliveryTime: '09:30', status: 'asignado_a_ruta' })) });
      const before = await routeSnapshot(database, route.routeId);
      expect((await request(app).post('/courier-assignments').send({ routeId: route.routeId, courierId: id })).status).toBe(409);
      expect(await routeSnapshot(database, route.routeId)).toEqual(before);
    });
    it.each(['unavailable', 'disabled', 'capacity', 'empty'])('rechaza %s sin cambios parciales', async variant => {
      const id = await courier(variant === 'capacity' ? 1 : 4, variant !== 'unavailable');
      if (variant === 'disabled') disableCourier(id);
      const route = await preparedRoute(database, variant === 'empty' ? 0 : 2);
      const before = await routeSnapshot(database, route.routeId);
      const response = await request(app).post('/courier-assignments').send({ routeId: route.routeId, courierId: id });
      expect(response.status).toBe(409); expect(response.body.code).toBe('DATA_CONFLICT');
      expect(await routeSnapshot(database, route.routeId)).toEqual(before);
    });
    it('responde errores explícitos por referencias inexistentes o inválidas', async () => {
      const id = await courier(); const route = await preparedRoute(database);
      const missingCourier = await request(app).post('/courier-assignments').send({ routeId: route.routeId, courierId: randomUUID() });
      expect(missingCourier.status).toBe(404); expect(missingCourier.body.code).toBe('COURIER_NOT_FOUND');
      const missingRoute = await request(app).post('/courier-assignments').send({ routeId: randomUUID(), courierId: id });
      expect(missingRoute.status).toBe(404); expect(missingRoute.body.code).toBe('ROUTE_NOT_FOUND');
      expect((await request(app).post('/courier-assignments').send({ routeId: 'invalid', courierId: id })).status).toBe(400);
    });
    it.each([1, 2, 3])('dos conexiones y peticiones HTTP concurrentes reservan solo una ruta (ronda %i)', async () => {
      const firstPid = await database.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const secondPid = await secondDatabase.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(firstPid[0]!.pid).not.toBe(secondPid[0]!.pid);
      const id = await courier(); const routes = [await preparedRoute(database), await preparedRoute(database)];
      const before = await Promise.all(routes.map(route => routeSnapshot(database, route.routeId)));
      const responses = await Promise.all([
        request(app).post('/courier-assignments').send({ routeId: routes[0]!.routeId, courierId: id }),
        request(secondApp).post('/courier-assignments').send({ routeId: routes[1]!.routeId, courierId: id }),
      ]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const rejected = responses.findIndex(response => response.status === 409);
      expect(await routeSnapshot(database, routes[rejected]!.routeId)).toEqual(before[rejected]);
      const active = await database.$queryRaw<{ id: string }[]>`SELECT id FROM logistica.routes WHERE courier_id=${id}::uuid AND status IN ('asignada','en_curso')`;
      expect(active).toHaveLength(1);
      expect((await request(app).get(`/couriers/${id}/route`)).body.item.routeId).toBe(active[0]!.id);
    });
    it('dos repartidores concurrentes no reemplazan al ganador de la misma ruta', async () => {
      const first = await courier(); const second = await courier(); const route = await preparedRoute(database);
      const responses = await Promise.all([
        request(app).post('/courier-assignments').send({ routeId: route.routeId, courierId: first }),
        request(secondApp).post('/courier-assignments').send({ routeId: route.routeId, courierId: second }),
      ]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const loser = responses[0]!.status === 409 ? first : second;
      expect((await request(app).get(`/couriers/${loser}/route`)).body).toEqual({ item: null });
    });
    it('traduce fallo de conexión a 503 sin exponer detalles', async () => {
      const bad = new URL(process.env['TEST_DATABASE_URL']!); bad.port = '1';
      const disconnected = (await import('../../../src/bootstrap/database.js')).createDatabaseClient(bad.toString());
      try {
        const response = await request(application(disconnected)).get('/couriers');
        expect(response.status).toBe(503); expect(response.body.code).toBe('PERSISTENCE_UNAVAILABLE');
        expect(JSON.stringify(response.body)).not.toMatch(/postgresql|SQLSTATE|password|127\.0\.0\.1/);
      } finally { await disconnected.$disconnect(); }
    });
  });
});

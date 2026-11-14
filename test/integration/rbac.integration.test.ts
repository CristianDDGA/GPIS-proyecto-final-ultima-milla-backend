import { Router } from 'express';
import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { RequestActorContext } from '../../src/modules/deliveries/infrastructure/context/request-actor.context.js';
import { StaticActorContext } from '../../src/modules/deliveries/infrastructure/context/static-actor.context.js';

const TEST_SECRET = 'rbac-integration-secret-key-12345';
const OWN_COURIER_ID = '40000000-0000-4000-8000-000000000001';
const OTHER_COURIER_ID = '40000000-0000-4000-8000-000000000002';
const ADMIN_ID = '30000000-0000-4000-8000-000000000001';
const DRIVER_ID = '30000000-0000-4000-8000-000000000002';
const CUSTOMER_ID = '30000000-0000-4000-8000-000000000009';

describe('RBAC & RequestActorContext Integration (in-memory)', () => {
  const tokens = new HmacJwtTokenService(TEST_SECRET);
  const adminToken = tokens.sign({ sub: ADMIN_ID, role: 'personal', authSubject: 'admin@test', courierId: null });
  const driverToken = tokens.sign({
    sub: DRIVER_ID,
    role: 'repartidor',
    authSubject: 'driver@test',
    courierId: OWN_COURIER_ID,
  });
  const customerToken = tokens.sign({ sub: CUSTOMER_ID, role: 'cliente', authSubject: 'customer@test', courierId: null });

  const actorContext = new RequestActorContext(new StaticActorContext('fallback-id'));
  const stubRouter = Router();
  stubRouter.get('/zones', (_req, res) => res.status(200).json({ ok: true }));
  stubRouter.post('/zones', (_req, res) => res.status(201).json({ ok: true }));
  stubRouter.post('/orders', (_req, res) => res.status(201).json({ ok: true }));
  stubRouter.get('/orders', (_req, res) => res.status(200).json({ ok: true }));
  stubRouter.post('/route-plans', (_req, res) => res.status(200).json({ ok: true }));
  stubRouter.get('/routes', (_req, res) => res.status(200).json({ ok: true }));
  stubRouter.post('/couriers', (_req, res) => res.status(201).json({ ok: true }));
  stubRouter.get('/couriers/:id/route', (_req, res) => res.status(200).json({ ok: true }));
  stubRouter.patch('/couriers/:id/availability', (_req, res) => res.status(200).json({ ok: true }));
  stubRouter.post('/delivery-status-changes', (_req, res) => {
    res.status(200).json({ actor: actorContext.getCurrentActor() });
  });

  const app = createApp({
    webOrigin: 'http://127.0.0.1:5173',
    tokenService: tokens,
    routers: [{ basePath: '/', router: stubRouter }],
  });

  test('rechaza peticiones sin token (401) excepto /health (200)', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/zones')).status).toBe(401);
    expect((await request(app).post('/orders').send({})).status).toBe(401);
    expect((await request(app).post('/route-plans').send({})).status).toBe(401);
  });

  test('rol cliente: puede consultar zonas y crear/ver pedidos, pero recibe 403 en rutas, repartidores y entregas', async () => {
    expect((await request(app).get('/zones').set('Authorization', `Bearer ${customerToken}`)).status).toBe(200);
    expect((await request(app).post('/orders').set('Authorization', `Bearer ${customerToken}`).send({})).status).toBe(201);
    expect((await request(app).get('/orders').set('Authorization', `Bearer ${customerToken}`)).status).toBe(200);

    expect((await request(app).post('/zones').set('Authorization', `Bearer ${customerToken}`).send({})).status).toBe(403);
    expect((await request(app).post('/route-plans').set('Authorization', `Bearer ${customerToken}`).send({})).status).toBe(403);
    expect((await request(app).get('/routes').set('Authorization', `Bearer ${customerToken}`)).status).toBe(403);
    expect((await request(app).post('/couriers').set('Authorization', `Bearer ${customerToken}`).send({})).status).toBe(403);
    expect((await request(app).post('/delivery-status-changes').set('Authorization', `Bearer ${customerToken}`).send({})).status).toBe(403);
  });

  test('rol repartidor: accede a su propia ruta/disponibilidad y entregas; recibe 403 en otro repartidor y administración', async () => {
    expect((await request(app).get(`/couriers/${OWN_COURIER_ID}/route`).set('Authorization', `Bearer ${driverToken}`)).status).toBe(200);
    expect((await request(app).patch(`/couriers/${OWN_COURIER_ID}/availability`).set('Authorization', `Bearer ${driverToken}`).send({})).status).toBe(200);
    expect((await request(app).get('/routes').set('Authorization', `Bearer ${driverToken}`)).status).toBe(200);

    const deliveryRes = await request(app).post('/delivery-status-changes').set('Authorization', `Bearer ${driverToken}`).send({});
    expect(deliveryRes.status).toBe(200);
    expect(deliveryRes.body.actor).toEqual({ actorId: DRIVER_ID });

    expect((await request(app).get(`/couriers/${OTHER_COURIER_ID}/route`).set('Authorization', `Bearer ${driverToken}`)).status).toBe(403);
    expect((await request(app).patch(`/couriers/${OTHER_COURIER_ID}/availability`).set('Authorization', `Bearer ${driverToken}`).send({})).status).toBe(403);
    expect((await request(app).post('/zones').set('Authorization', `Bearer ${driverToken}`).send({})).status).toBe(403);
    expect((await request(app).post('/route-plans').set('Authorization', `Bearer ${driverToken}`).send({})).status).toBe(403);
    expect((await request(app).post('/orders').set('Authorization', `Bearer ${driverToken}`).send({})).status).toBe(403);
  });

  test('rol personal (admin): accede a todos los endpoints operativos', async () => {
    expect((await request(app).post('/zones').set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(201);
    expect((await request(app).post('/route-plans').set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(200);
    expect((await request(app).post('/couriers').set('Authorization', `Bearer ${adminToken}`).send({})).status).toBe(201);
    expect((await request(app).get(`/couriers/${OTHER_COURIER_ID}/route`).set('Authorization', `Bearer ${adminToken}`)).status).toBe(200);
  });
});

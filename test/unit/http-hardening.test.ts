import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';

const webOrigin = 'http://127.0.0.1:5173';

function echoRouter(): Router {
  const router = Router();
  router.post('/echo', (req, res) => res.status(200).json({ received: req.body ?? null }));
  router.put('/echo', (req, res) => res.status(200).json({ received: req.body ?? null }));
  router.patch('/echo', (req, res) => res.status(200).json({ received: req.body ?? null }));
  router.post('/no-body', (_req, res) => res.status(204).end());
  return router;
}

function appWith(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ webOrigin, routers: [{ basePath: '/', router: echoRouter() }], ...extra });
}

test('GET /health responde 200 sin comprobación de base de datos', async () => {
  const response = await request(appWith()).get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('GET /health responde 200 cuando PostgreSQL responde', async () => {
  let calls = 0;
  const response = await request(appWith({ checkDatabase: async () => { calls += 1; } })).get('/health');
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test('GET /health responde 503 con el envoltorio JSON si PostgreSQL falla', async () => {
  const response = await request(appWith({ checkDatabase: async () => { throw new Error('conexion caida'); } })).get('/health');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(response.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.ok(!JSON.stringify(response.body).includes('conexion caida'), 'no debe filtrar el error interno');
});

test('GET /health responde 503 si la comprobación supera el timeout', { timeout: 10_000 }, async () => {
  const hanging = () => new Promise<never>(() => undefined);
  const response = await request(appWith({ checkDatabase: hanging })).get('/health');
  assert.equal(response.status, 503);
});

test('las respuestas incluyen Cache-Control: no-store', async () => {
  const response = await request(appWith()).get('/health');
  assert.equal(response.headers['cache-control'], 'no-store');
});

for (const method of ['post', 'put', 'patch'] as const) {
  test(`${method.toUpperCase()} con cuerpo que no es objeto JSON responde 400`, async () => {
    const response = await request(appWith())[method]('/echo').set('Content-Type', 'application/json').send('[1,2]');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'VALIDATION_ERROR');
  });

  test(`${method.toUpperCase()} con objeto JSON válido pasa`, async () => {
    const response = await request(appWith())[method]('/echo').send({ ok: true });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.received, { ok: true });
  });
}

test('POST sin cuerpo en rutas que no lo requieren sigue funcionando', async () => {
  const response = await request(appWith()).post('/no-body');
  assert.equal(response.status, 204);
});

test('POST /orders y /zones siguen exigiendo un objeto JSON', async () => {
  for (const path of ['/orders', '/zones']) {
    const response = await request(appWith()).post(path);
    assert.equal(response.status, 400, path);
    assert.equal(response.body.code, 'VALIDATION_ERROR', path);
  }
});

function loginRouter(): Router {
  const router = Router();
  router.post('/login', (_req, res) => res.status(200).json({ ok: true }));
  router.post('/register', (_req, res) => res.status(201).json({ ok: true }));
  router.get('/me', (_req, res) => res.status(200).json({ ok: true }));
  return router;
}

function limitedApp(now: () => number, maxRequests = 3) {
  return createApp({
    webOrigin,
    routers: [{ basePath: '/auth', router: loginRouter() }],
    authRateLimit: { maxRequests, windowMs: 60_000, now },
  });
}

test('rate limiter: la solicitud siguiente al límite responde 429 con Retry-After', async () => {
  const app = limitedApp(() => 1_000);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await request(app).post('/auth/login').send({})).status, 200);
  }
  const blocked = await request(app).post('/auth/login').send({});
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'TOO_MANY_REQUESTS');
  assert.equal(blocked.body.error.code, 'TOO_MANY_REQUESTS');
  assert.equal(blocked.headers['retry-after'], '60');
});

test('rate limiter: cada ruta tiene su propio contador', async () => {
  const app = limitedApp(() => 1_000);
  for (let i = 0; i < 3; i += 1) await request(app).post('/auth/login').send({});
  assert.equal((await request(app).post('/auth/login').send({})).status, 429);
  assert.equal((await request(app).post('/auth/register').send({})).status, 201);
});

test('rate limiter: no limita otras rutas ni métodos', async () => {
  const app = limitedApp(() => 1_000, 1);
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await request(app).get('/auth/me')).status, 200);
  }
});

test('rate limiter: la ventana se reinicia al expirar', async () => {
  let current = 1_000;
  const app = limitedApp(() => current);
  for (let i = 0; i < 4; i += 1) await request(app).post('/auth/login').send({});
  assert.equal((await request(app).post('/auth/login').send({})).status, 429);
  current += 60_001;
  assert.equal((await request(app).post('/auth/login').send({})).status, 200);
});

test('rate limiter: sin configuración no se limita', async () => {
  const app = createApp({ webOrigin, routers: [{ basePath: '/auth', router: loginRouter() }] });
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await request(app).post('/auth/login').send({})).status, 200);
  }
});

test('rate limiter: sin TRUST_PROXY ignora X-Forwarded-For; con trust proxy separa clientes por IP real', async () => {
  const send = (app: ReturnType<typeof limitedApp>, ip: string) =>
    request(app).post('/auth/login').set('X-Forwarded-For', ip).send({});

  const direct = limitedApp(() => 1_000, 1);
  assert.equal((await send(direct, '10.0.0.1')).status, 200);
  assert.equal((await send(direct, '10.0.0.2')).status, 429, 'sin proxy confiable no se puede falsear la IP');

  const proxied = createApp({
    webOrigin,
    routers: [{ basePath: '/auth', router: loginRouter() }],
    authRateLimit: { maxRequests: 1, windowMs: 60_000, now: () => 1_000 },
    trustProxyHops: 1,
  });
  assert.equal((await send(proxied, '10.0.0.1')).status, 200);
  assert.equal((await send(proxied, '10.0.0.2')).status, 200, 'cada cliente real tiene su contador');
  assert.equal((await send(proxied, '10.0.0.1')).status, 429);
});

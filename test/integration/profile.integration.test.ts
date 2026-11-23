import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { createPersistedApp } from '../../src/bootstrap/create-persisted-app.js';
import { createAuthModule } from '../../src/modules/auth/index.js';
import { CapturingEmailSender, InMemoryAuthRepository } from '../support/in-memory-auth.js';
import { realDatabase } from './database.fixture.js';
import { deliveryDatabase, resetTestData } from './sprint03/deliveries.fixture.js';

const SECRET = 'integration-test-jwt-secret-1234';
const ORIGIN = 'http://127.0.0.1:5173';
const PASSWORD = 'ClaveSegura2026';

type App = ReturnType<typeof createApp>;

/** Perfil propio (migración 015): ver y editar nombre y teléfono. Corre en memoria y en PostgreSQL real. */
function defineProfileSuite(buildApp: () => App | Promise<App>): void {
  let app: App;
  beforeEach(async () => { app = await buildApp(); });

  async function registerAndLogin(email: string): Promise<string> {
    const register = await request(app).post('/auth/register').send({ email, password: PASSWORD, displayName: 'Ana Pérez' });
    expect(register.status).toBe(201);
    if (typeof register.body.token === 'string') return register.body.token as string;
    const login = await request(app).post('/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return login.body.token as string;
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('muestra el perfil propio con sus datos de cuenta', async () => {
    const token = await registerAndLogin(`perfil-${randomUUID().slice(0, 8)}@test.com`);
    const response = await request(app).get('/auth/me/profile').set(bearer(token));
    expect(response.status).toBe(200);
    expect(response.body.profile).toMatchObject({
      role: 'cliente', publicRole: 'cliente', displayName: 'Ana Pérez', phone: null, hasPassword: true, googleLinked: false,
    });
    expect(Number.isFinite(Date.parse(response.body.profile.createdAt))).toBe(true);
    expect(response.body.profile).not.toHaveProperty('passwordHash');
  });

  it('cambia el nombre y el teléfono; lo que no se envía queda igual', async () => {
    const token = await registerAndLogin(`editar-${randomUUID().slice(0, 8)}@test.com`);
    const phone = await request(app).patch('/auth/me/profile').set(bearer(token)).send({ phone: '+593 99 123 4567' });
    expect(phone.status).toBe(200);
    expect(phone.body.profile).toMatchObject({ displayName: 'Ana Pérez', phone: '+593991234567' });

    const name = await request(app).patch('/auth/me/profile').set(bearer(token)).send({ displayName: 'Ana María Pérez' });
    expect(name.status).toBe(200);
    expect(name.body.profile).toMatchObject({ displayName: 'Ana María Pérez', phone: '+593991234567' });

    const cleared = await request(app).patch('/auth/me/profile').set(bearer(token)).send({ phone: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile.phone).toBeNull();

    const me = await request(app).get('/auth/me').set(bearer(token));
    expect(me.body.user.displayName).toBe('Ana María Pérez');
  });

  it('valida el nombre, el teléfono y los campos', async () => {
    const token = await registerAndLogin(`valida-${randomUUID().slice(0, 8)}@test.com`);
    const patch = (body: object) => request(app).patch('/auth/me/profile').set(bearer(token)).send(body);
    expect((await patch({ displayName: 'Ana 2' })).status).toBe(400);
    expect((await patch({ phone: '12345' })).status).toBe(400);
    expect((await patch({ phone: 'abc1234567' })).status).toBe(400);
    expect((await patch({ email: 'otro@test.com' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });

  it('pide sesión', async () => {
    expect((await request(app).get('/auth/me/profile')).status).toBe(401);
    expect((await request(app).patch('/auth/me/profile').send({ phone: '0991234567' })).status).toBe(401);
  });
}

function memoryApp(): App {
  const repository = new InMemoryAuthRepository();
  const authModule = createAuthModule({ repository, jwtSecret: SECRET, emailSender: new CapturingEmailSender(), emailVerificationRequired: false });
  return createApp({
    webOrigin: ORIGIN,
    tokenService: authModule.tokenService,
    tokenRevocationStore: authModule.revocationStore,
    routers: [{ basePath: '/auth', router: authModule.router }],
    errorHandlers: [authModule.errorHandler],
  });
}

describe('Perfil propio · API HTTP con repositorio en memoria', () => {
  defineProfileSuite(memoryApp);
});

const describeReal = realDatabase ? describe : describe.skip;

describeReal('Perfil propio · PostgreSQL real (migración 015)', () => {
  let database: ReturnType<typeof deliveryDatabase>;
  beforeAll(() => { database = deliveryDatabase(); });
  afterAll(async () => { await database?.$disconnect(); });

  defineProfileSuite(() => {
    resetTestData();
    return createPersistedApp(database, ORIGIN, { jwtSecret: SECRET, emailSender: new CapturingEmailSender(), emailVerificationRequired: false });
  });
});

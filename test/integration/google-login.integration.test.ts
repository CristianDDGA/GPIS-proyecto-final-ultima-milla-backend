import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { createPersistedApp } from '../../src/bootstrap/create-persisted-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { createAuthModule } from '../../src/modules/auth/index.js';
import { CapturingEmailSender, InMemoryAuthRepository } from '../support/in-memory-auth.js';
import { defineGoogleLoginSuite, FakeGoogleVerifier, type GoogleHarness, type GoogleHarnessOptions } from '../support/google-auth-suite.js';
import { realDatabase } from './database.fixture.js';
import { createFixtureActor, deliveryDatabase, resetTestData, runAdminSql } from './sprint03/deliveries.fixture.js';

const SECRET = 'integration-test-jwt-secret-1234';
const ORIGIN = 'http://127.0.0.1:5173';

function memoryHarness(options: GoogleHarnessOptions = {}): GoogleHarness {
  const repository = new InMemoryAuthRepository();
  const emails = new CapturingEmailSender();
  const google = new FakeGoogleVerifier();
  const authModule = createAuthModule({
    repository,
    jwtSecret: SECRET,
    emailSender: emails,
    ...(options.googleEnabled === false ? {} : { googleVerifier: google }),
  });
  const app = createApp({
    webOrigin: ORIGIN,
    tokenService: authModule.tokenService,
    tokenRevocationStore: authModule.revocationStore,
    routers: [{ basePath: '/auth', router: authModule.router }],
    errorHandlers: [authModule.errorHandler],
  });
  const adminId = randomUUID();
  const adminToken = authModule.tokenService.sign({ sub: adminId, role: 'personal', authSubject: 'admin@test', courierId: null });
  return {
    app,
    adminToken,
    emails,
    google,
    countAccounts: async (email) => ((await repository.findByEmail(email)) ? 1 : 0),
  };
}

describe('Inicio de sesión con Google · API HTTP con repositorio en memoria', () => {
  defineGoogleLoginSuite(memoryHarness);
});

const describeReal = realDatabase ? describe : describe.skip;

// La misma suite contra PostgreSQL real con la migración 014.
describeReal('Inicio de sesión con Google · PostgreSQL real (migración 014)', () => {
  let database: ReturnType<typeof deliveryDatabase>;
  beforeAll(() => { database = deliveryDatabase(); });
  afterAll(async () => { await database?.$disconnect(); });

  defineGoogleLoginSuite((options: GoogleHarnessOptions = {}): GoogleHarness => {
    resetTestData();
    const emails = new CapturingEmailSender();
    const google = new FakeGoogleVerifier();
    const tokens = new HmacJwtTokenService(SECRET);
    const admin = createFixtureActor('personal');
    const app = createPersistedApp(database, ORIGIN, {
      jwtSecret: SECRET,
      emailSender: emails,
      ...(options.googleEnabled === false ? {} : { googleTokenVerifier: google }),
    });
    return {
      app,
      adminToken: tokens.sign({ sub: admin.actorId, role: 'personal', authSubject: admin.authSubject, courierId: null }),
      emails,
      google,
      countAccounts: async (email) => Number(runAdminSql(`SELECT count(*) FROM logistica.app_users WHERE lower(email) = lower('${email.replace(/'/g, '')}');`)),
    };
  });

  it('en la base queda un cliente verificado por google, sin contraseña, con su identidad vinculada', async () => {
    resetTestData();
    const google = new FakeGoogleVerifier();
    const app = createPersistedApp(database, ORIGIN, { jwtSecret: SECRET, emailSender: new CapturingEmailSender(), googleTokenVerifier: google });
    const response = await request(app).post('/auth/google').send({ idToken: google.tokenFor({ sub: 'sub-pg-1', email: 'pg@gmail.com', name: 'Pedro Gómez' }) });
    expect(response.status).toBe(200);
    expect(runAdminSql("SELECT role || '|' || email_verified_via || '|' || (password_hash IS NULL)::text || '|' || google_sub || '|' || display_name FROM logistica.app_users WHERE email = 'pg@gmail.com';"))
      .toBe('cliente|google|true|sub-pg-1|Pedro Gómez');
  });
});

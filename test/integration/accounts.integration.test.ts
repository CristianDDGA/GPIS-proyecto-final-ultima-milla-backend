import request from 'supertest';
import { createPersistedApp } from '../../src/bootstrap/create-persisted-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { realDatabase } from './database.fixture.js';
import { createFixtureActor, deliveryDatabase, resetTestData, runAdminSql } from './sprint03/deliveries.fixture.js';
import { CapturingEmailSender } from '../support/in-memory-auth.js';

const SECRET = 'integration-test-jwt-secret-1234';
const ORIGIN = 'http://127.0.0.1:5173';
const PASSWORD = 'ClaveSegura2026';

// Verificación de correo, recuperación y cierre de sesiones contra PostgreSQL real (migración 007).
const describeReal = realDatabase ? describe : describe.skip;

describeReal('Cuentas · verificación, recuperación y sesiones con PostgreSQL real', () => {
  let database: ReturnType<typeof deliveryDatabase>;
  let emails: CapturingEmailSender;
  let app: ReturnType<typeof createPersistedApp>;
  const tokens = new HmacJwtTokenService(SECRET);

  const buildApp = (options: { emailVerificationRequired?: boolean } = {}) =>
    createPersistedApp(database, ORIGIN, { jwtSecret: SECRET, emailSender: emails, ...options });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function register(email: string) {
    const response = await request(app).post('/auth/register').send({ email, password: PASSWORD, displayName: 'Ana Pérez' });
    expect(response.status).toBe(201);
    return response;
  }

  beforeAll(() => { database = deliveryDatabase(); });
  beforeEach(() => {
    resetTestData();
    emails = new CapturingEmailSender();
    app = buildApp();
  });
  afterAll(async () => { await database?.$disconnect(); });

  it('registro → login bloqueado → código → verificado → login', async () => {
    const registered = await register('ana@test.com');
    expect(registered.body.token).toBeUndefined();
    expect(registered.body.verificationRequired).toBe(true);
    expect((await request(app).post('/auth/login').send({ email: 'ana@test.com', password: PASSWORD })).body.code).toBe('EMAIL_NOT_VERIFIED');

    const verified = await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code: emails.lastCodeFor('ana@test.com') });
    expect(verified.status).toBe(200);
    expect(verified.body.user.emailVerified).toBe(true);
    expect(runAdminSql("SELECT email_verified_via FROM logistica.app_users WHERE email='ana@test.com';")).toBe('code');
    expect((await request(app).post('/auth/login').send({ email: 'ana@test.com', password: PASSWORD })).status).toBe(200);
    // El código se consumió: no queda ninguno vigente.
    expect(runAdminSql('SELECT count(*) FROM logistica.email_codes;')).toBe('0');
  });

  it('solo se guarda el hash del código (nunca el código) y el código es de un solo uso', async () => {
    await register('ana@test.com');
    const code = emails.lastCodeFor('ana@test.com');
    const stored = runAdminSql('SELECT code_hash FROM logistica.email_codes;');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(code);
    expect((await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code })).status).toBe(200);
    expect((await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code })).status).toBe(400);
  });

  it('cinco códigos incorrectos invalidan el código vigente aunque luego se envíe el correcto', async () => {
    await register('ana@test.com');
    const real = emails.lastCodeFor('ana@test.com');
    const wrong = real === '000000' ? '111111' : '000000';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code: wrong })).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429]);
    expect((await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code: real })).status).toBe(400);
    expect(runAdminSql("SELECT email_verified_via IS NULL FROM logistica.app_users WHERE email='ana@test.com';")).toBe('t');
  });

  it('un código caducado responde CODE_EXPIRED y se elimina', async () => {
    await register('ana@test.com');
    const code = emails.lastCodeFor('ana@test.com');
    runAdminSql("UPDATE logistica.email_codes SET expires_at = clock_timestamp() - interval '1 second';");
    const response = await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('CODE_EXPIRED');
    expect(runAdminSql('SELECT count(*) FROM logistica.email_codes;')).toBe('0');
  });

  it('el reenvío respeta el cooldown de 60 s en la base y reemplaza el código anterior', async () => {
    await register('ana@test.com');
    const first = emails.lastCodeFor('ana@test.com');
    await request(app).post('/auth/resend-verification').send({ email: 'ana@test.com' });
    expect(emails.sent).toHaveLength(1);

    runAdminSql("UPDATE logistica.email_codes SET sent_at = clock_timestamp() - interval '61 seconds';");
    await request(app).post('/auth/resend-verification').send({ email: 'ana@test.com' });
    expect(emails.sent).toHaveLength(2);
    const second = emails.lastCodeFor('ana@test.com');
    if (second !== first) {
      expect((await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code: first })).status).toBe(400);
    }
    expect((await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code: second })).status).toBe(200);
  });

  it('recuperación de clave: cierra sesiones anteriores incluso para otra instancia de la API (lee la base)', async () => {
    await register('ana@test.com');
    const session = await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code: emails.lastCodeFor('ana@test.com') });
    const oldToken = session.body.token as string;
    await sleep(1100);

    await request(app).post('/auth/forgot-password').send({ email: 'ana@test.com' });
    const reset = await request(app).post('/auth/reset-password').send({ email: 'ana@test.com', code: emails.lastCodeFor('ana@test.com'), newPassword: 'NuevaClave456' });
    expect(reset.status).toBe(200);

    const otherInstance = buildApp();
    expect((await request(otherInstance).get('/auth/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
    expect((await request(app).get('/auth/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
    expect((await request(app).post('/auth/login').send({ email: 'ana@test.com', password: PASSWORD })).status).toBe(401);
    const login = await request(app).post('/auth/login').send({ email: 'ana@test.com', password: 'NuevaClave456' });
    expect(login.status).toBe(200);
    expect((await request(otherInstance).get('/auth/me').set('Authorization', `Bearer ${login.body.token}`)).status).toBe(200);
  });

  it('cambio de clave con sesión: valida la actual, cierra las demás y mantiene la sesión que cambió', async () => {
    await register('ana@test.com');
    const first = await request(app).post('/auth/verify-email').send({ email: 'ana@test.com', code: emails.lastCodeFor('ana@test.com') });
    await sleep(1100);
    const changed = await request(app).post('/auth/change-password').set('Authorization', `Bearer ${first.body.token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'NuevaClave456' });
    expect(changed.status).toBe(200);
    expect((await request(app).get('/auth/me').set('Authorization', `Bearer ${first.body.token}`)).status).toBe(401);
    expect((await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${changed.body.token}`)).status).toBe(200);
  });

  it('un conductor creado por el admin nace verificado y no depende de un correo real; el admin restablece su clave', async () => {
    const admin = createFixtureActor('personal');
    const adminToken = tokens.sign({ sub: admin.actorId, role: 'personal', authSubject: admin.authSubject, courierId: null });
    const created = await request(app).post('/auth/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'conductor@correo.ficticio.com', password: 'Ruta-Norte-Lluvia-2026', role: 'repartidor', displayName: 'Carlos Conductor' });
    expect(created.status).toBe(201);
    expect(created.body.user.emailVerified).toBe(true);
    expect(runAdminSql("SELECT email_verified_via FROM logistica.app_users WHERE email='conductor@correo.ficticio.com';")).toBe('admin');
    expect(emails.sent).toHaveLength(0);
    expect((await request(app).post('/auth/login').send({ email: 'conductor@correo.ficticio.com', password: 'Ruta-Norte-Lluvia-2026' })).status).toBe(200);

    const reset = await request(app).post(`/auth/users/${created.body.user.id}/reset-password`).set('Authorization', `Bearer ${adminToken}`).send({ newPassword: 'ClaveNueva789' });
    expect(reset.status).toBe(200);
    expect((await request(app).post('/auth/login').send({ email: 'conductor@correo.ficticio.com', password: 'ClaveNueva789' })).status).toBe(200);
    // Sin código verificado por correo, no hay recuperación por correo.
    await request(app).post('/auth/forgot-password').send({ email: 'conductor@correo.ficticio.com' });
    expect(emails.sent).toHaveLength(0);
  });

  it('modo demo: el cliente nace verificado con token, sin correo ni códigos', async () => {
    const demo = buildApp({ emailVerificationRequired: false });
    const response = await request(demo).post('/auth/register').send({ email: 'demo@test.com', password: PASSWORD, displayName: 'Demo Cliente' });
    expect(response.status).toBe(201);
    expect(response.body.token).toEqual(expect.any(String));
    expect(runAdminSql("SELECT email_verified_via FROM logistica.app_users WHERE email='demo@test.com';")).toBe('demo');
    expect(emails.sent).toHaveLength(0);
    // Una cuenta 'demo' no tiene correo comprobado: no hay recuperación por correo.
    await request(demo).post('/auth/forgot-password').send({ email: 'demo@test.com' });
    expect(emails.sent).toHaveLength(0);
  });

  it('el rol de la aplicación no puede leer los códigos ni invocar las funciones internas ni verificar cuentas a mano', async () => {
    await register('ana@test.com');
    await expect(database.$queryRaw`SELECT * FROM logistica.email_codes`).rejects.toThrow();
    await expect(database.$queryRaw`SELECT logistica.consume_email_code(gen_random_uuid(), 'verify_email'::text, ${'0'.repeat(64)}::text)`).rejects.toThrow();
    await expect(database.$queryRaw`UPDATE logistica.app_users SET email_verified_at = now()`).rejects.toThrow();
  });
});

import request from 'supertest';
import { createPersistedApp } from '../../src/bootstrap/create-persisted-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { realDatabase } from './database.fixture.js';
import { createFixtureActor, deliveryDatabase, prepareAssignedRoute, resetTestData, runAdminSql } from './sprint03/deliveries.fixture.js';
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

  it('registrar un correo que ya existe responde 409 (no 503), también con otra mayúscula, y no crea otra cuenta', async () => {
    await register('ana@test.com');
    for (const email of ['ana@test.com', 'ANA@test.com']) {
      const duplicate = await request(app).post('/auth/register').send({ email, password: PASSWORD, displayName: 'Otra Ana' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('EMAIL_ALREADY_EXISTS');
    }
    expect(runAdminSql("SELECT count(*) FROM logistica.app_users WHERE lower(email)='ana@test.com';")).toBe('1');
  });

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

describeReal('Gestión de usuarios · PostgreSQL real (migración 008)', () => {
  let database: ReturnType<typeof deliveryDatabase>;
  let emails: CapturingEmailSender;
  let app: ReturnType<typeof createPersistedApp>;
  const tokens = new HmacJwtTokenService(SECRET);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(() => { database = deliveryDatabase(); });
  beforeEach(() => {
    resetTestData();
    emails = new CapturingEmailSender();
    app = createPersistedApp(database, ORIGIN, { jwtSecret: SECRET, emailSender: emails });
  });
  afterAll(async () => { await database?.$disconnect(); });

  function adminAuth() {
    const actor = createFixtureActor('personal');
    return { id: actor.actorId, auth: { Authorization: `Bearer ${tokens.sign({ sub: actor.actorId, role: 'personal', authSubject: actor.authSubject, courierId: null })}` } };
  }

  async function createDriver(auth: { Authorization: string }, email: string) {
    const response = await request(app).post('/auth/users').set(auth)
      .send({ email, password: 'Faro-Verde-Mar-2026', role: 'repartidor', displayName: 'Carlos Conductor' });
    expect(response.status).toBe(201);
    return response.body.user as { id: string };
  }

  it('lista con filtros, total y paginación desde la base, y no expone el hash de la clave', async () => {
    const boss = adminAuth();
    await createDriver(boss.auth, 'carlos@correo.ficticio.com');
    await createDriver(boss.auth, 'maria@correo.ficticio.com');
    const all = await request(app).get('/auth/users').set(boss.auth);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(JSON.stringify(all.body)).not.toMatch(/password|hash/i);
    const drivers = await request(app).get('/auth/users?role=repartidor&limit=1&offset=1').set(boss.auth);
    expect(drivers.body).toEqual(expect.objectContaining({ total: 2, limit: 1, offset: 1 }));
    expect(drivers.body.items).toHaveLength(1);
    expect((await request(app).get('/auth/users?q=MARIA').set(boss.auth)).body.total).toBe(1);
    expect((await request(app).get('/auth/users?q=%25').set(boss.auth)).body.total).toBe(0);
    expect((await request(app).get('/auth/users?q=\'%3B%20DROP%20TABLE%20logistica.app_users%3B--').set(boss.auth)).body.total).toBe(0);
    expect((await request(app).get('/auth/users')).status).toBe(401);
  });

  it('desactivar cierra las sesiones (también en otra instancia), bloquea el login y reactivar lo devuelve', async () => {
    const boss = adminAuth();
    const driver = await createDriver(boss.auth, 'carlos@correo.ficticio.com');
    const session = await request(app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: 'Faro-Verde-Mar-2026' });
    await sleep(1100);

    const off = await request(app).patch(`/auth/users/${driver.id}`).set(boss.auth).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.user.isActive).toBe(false);
    expect(runAdminSql(`SELECT is_active, tokens_valid_after IS NOT NULL FROM logistica.app_users WHERE id='${driver.id}';`)).toBe('f|t');

    const otherInstance = createPersistedApp(database, ORIGIN, { jwtSecret: SECRET, emailSender: emails });
    expect((await request(otherInstance).get('/auth/me').set('Authorization', `Bearer ${session.body.token}`)).status).toBe(401);
    const blocked = await request(app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: 'Faro-Verde-Mar-2026' });
    expect(blocked.body.code).toBe('USER_INACTIVE');

    await request(app).patch(`/auth/users/${driver.id}`).set(boss.auth).send({ isActive: true });
    expect((await request(app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: 'Faro-Verde-Mar-2026' })).status).toBe(200);
  });

  it('el último administrador activo no se puede desactivar y no se puede desactivar a uno mismo', async () => {
    const boss = adminAuth();
    const only = await request(app).patch(`/auth/users/${boss.id}`).set(boss.auth).send({ isActive: false });
    expect(only.status).toBe(409);
    expect(only.body.code).toBe('CANNOT_DEACTIVATE_SELF');

    // Una cuenta de administrador desactivada por otra vía no deja al sistema sin administrador activo.
    const other = adminAuth();
    const result = runAdminSql(`SELECT logistica.set_app_user_active('${other.id}'::uuid, false);`);
    expect(result).toBe('OK');
    const last = runAdminSql(`SELECT logistica.set_app_user_active('${boss.id}'::uuid, false);`);
    expect(last).toBe('LAST_ADMIN');
    expect(runAdminSql(`SELECT is_active FROM logistica.app_users WHERE id='${boss.id}';`)).toBe('t');
  });

  it('un repartidor con una ruta asignada no se puede desactivar (409 USER_HAS_ACTIVE_ROUTE)', async () => {
    const boss = adminAuth();
    const driverUser = createFixtureActor('repartidor');
    const route = await prepareAssignedRoute(database, { courierUserId: driverUser.actorId });
    expect(route.routeId).toBeTruthy();
    const response = await request(app).patch(`/auth/users/${driverUser.actorId}`).set(boss.auth).send({ isActive: false });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('USER_HAS_ACTIVE_ROUTE');
    expect(runAdminSql(`SELECT is_active FROM logistica.app_users WHERE id='${driverUser.actorId}';`)).toBe('t');
  });

  it('el rol de la aplicación no puede cambiar is_active por su cuenta, solo mediante la función', async () => {
    const boss = adminAuth();
    const driver = await createDriver(boss.auth, 'carlos@correo.ficticio.com');
    await expect(database.$queryRaw`UPDATE logistica.app_users SET is_active = false WHERE id = ${driver.id}::uuid`).rejects.toThrow();
    const rows = await database.$queryRaw<Array<{ result: string }>>`SELECT logistica.set_app_user_active(${driver.id}::uuid, true) AS result`;
    expect(rows[0]?.result).toBe('UNCHANGED');
    expect(emails.sent).toHaveLength(0);
  });
});

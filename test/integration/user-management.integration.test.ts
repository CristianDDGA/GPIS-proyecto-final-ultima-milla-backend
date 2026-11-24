import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { createAuthModule } from '../../src/modules/auth/index.js';
import type { SecurityEvent } from '../../src/modules/auth/application/ports/security-log.port.js';
import { CapturingEmailSender, InMemoryAuthRepository } from '../support/in-memory-auth.js';

const SECRET = 'integration-test-jwt-secret-1234';
const ADMIN_PASSWORD = 'Torre-Azul-Cobre-2026';
const USER_PASSWORD = 'Faro-Verde-Mar-2026';

function build() {
  const repository = new InMemoryAuthRepository();
  const emails = new CapturingEmailSender();
  const events: SecurityEvent[] = [];
  const authModule = createAuthModule({ repository, jwtSecret: SECRET, emailSender: emails, securityLog: (event) => { events.push(event); } });
  const app = createApp({
    webOrigin: 'http://127.0.0.1:5173',
    tokenService: authModule.tokenService,
    tokenRevocationStore: authModule.revocationStore,
    routers: [{ basePath: '/auth', router: authModule.router }],
    errorHandlers: [authModule.errorHandler],
  });
  return { app, repository, events, authModule, emails };
}
type Ctx = ReturnType<typeof build>;

async function admin(ctx: Ctx, email = 'admin@test.com') {
  const user = await ctx.authModule.useCases.registerByAdmin({ role: 'personal' }, { email, password: ADMIN_PASSWORD, role: 'admin', displayName: 'Administrador Principal' });
  const login = await request(ctx.app).post('/auth/login').send({ email, password: ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  return { id: user.id, token: login.body.token as string, auth: { Authorization: `Bearer ${login.body.token}` } };
}

// No hay endpoint para crear usuarios: las cuentas de prueba se siembran con el caso de uso interno.
async function createUser(ctx: Ctx, _adminAuth: { Authorization: string }, email: string, role: 'repartidor' | 'cliente', displayName: string) {
  return ctx.authModule.useCases.registerByAdmin({ role: 'personal' }, { email, password: USER_PASSWORD, role, displayName });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Gestión de usuarios para el administrador (en memoria)', () => {
  test('solo el administrador puede listar, consultar y cambiar usuarios; sin token responde 401', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const driver = await createUser(ctx, boss.auth, 'carlos@correo.ficticio.com', 'repartidor', 'Carlos Conductor');
    const driverLogin = await request(ctx.app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: USER_PASSWORD });
    const driverAuth = { Authorization: `Bearer ${driverLogin.body.token}` };

    expect((await request(ctx.app).get('/auth/users')).status).toBe(401);
    for (const call of [
      request(ctx.app).get('/auth/users').set(driverAuth),
      request(ctx.app).get(`/auth/users/${driver.id}`).set(driverAuth),
      request(ctx.app).patch(`/auth/users/${driver.id}`).set(driverAuth).send({ isActive: false }),
    ]) {
      const response = await call;
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
    expect((await request(ctx.app).get('/auth/users').set(boss.auth)).status).toBe(200);
  });

  test('lista con filtros por rol, estado y texto, con paginación y total; nunca expone el hash de la clave', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    await createUser(ctx, boss.auth, 'carlos@correo.ficticio.com', 'repartidor', 'Carlos Conductor');
    await createUser(ctx, boss.auth, 'maria@correo.ficticio.com', 'repartidor', 'María Conductora');
    const client = await createUser(ctx, boss.auth, 'ana@correo.ficticio.com', 'cliente', 'Ana Pérez');
    await request(ctx.app).patch(`/auth/users/${client.id}`).set(boss.auth).send({ isActive: false });

    const all = await request(ctx.app).get('/auth/users').set(boss.auth);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(4);
    expect(all.body.limit).toBe(25);
    expect(all.body.offset).toBe(0);
    expect(JSON.stringify(all.body)).not.toMatch(/password|hash/i);
    expect(all.body.items[0]).toEqual(expect.objectContaining({
      id: expect.any(String), email: expect.any(String), role: expect.any(String), publicRole: expect.any(String),
      isActive: expect.any(Boolean), emailVerified: true, createdAt: expect.stringMatching(/Z$/),
    }));

    const drivers = await request(ctx.app).get('/auth/users?role=repartidor').set(boss.auth);
    expect(drivers.body.items.map((item: { email: string }) => item.email).sort()).toEqual(['carlos@correo.ficticio.com', 'maria@correo.ficticio.com']);
    expect((await request(ctx.app).get('/auth/users?role=admin').set(boss.auth)).body.total).toBe(1);
    expect((await request(ctx.app).get('/auth/users?isActive=false').set(boss.auth)).body.items.map((item: { id: string }) => item.id)).toEqual([client.id]);
    expect((await request(ctx.app).get('/auth/users?q=CONDUCTORA').set(boss.auth)).body.items).toHaveLength(1);
    expect((await request(ctx.app).get('/auth/users?q=correo.ficticio&limit=2&offset=1').set(boss.auth)).body).toEqual(expect.objectContaining({ total: 3, limit: 2, offset: 1 }));
    expect((await request(ctx.app).get('/auth/users?q=%25').set(boss.auth)).body.total).toBe(0);
  });

  test('rechaza parámetros inválidos con 400', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    for (const query of ['role=superadmin', 'isActive=quizas', 'limit=0', 'limit=101', 'limit=abc', 'offset=-1', `q=${'x'.repeat(101)}`]) {
      const response = await request(ctx.app).get(`/auth/users?${query}`).set(boss.auth);
      expect([query, response.status]).toEqual([query, 400]);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    }
    expect((await request(ctx.app).get('/auth/users/no-es-uuid').set(boss.auth)).status).toBe(400);
    expect((await request(ctx.app).get('/auth/users/11111111-1111-4111-8111-111111111111').set(boss.auth)).status).toBe(404);
  });

  test('desactivar: no puede iniciar sesión y su sesión abierta se cierra; reactivar le devuelve el acceso', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const driver = await createUser(ctx, boss.auth, 'carlos@correo.ficticio.com', 'repartidor', 'Carlos Conductor');
    const session = await request(ctx.app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: USER_PASSWORD });
    expect((await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${session.body.token}`)).status).toBe(200);
    await sleep(1100);

    const off = await request(ctx.app).patch(`/auth/users/${driver.id}`).set(boss.auth).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.user.isActive).toBe(false);
    expect((await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${session.body.token}`)).status).toBe(401);
    const blocked = await request(ctx.app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: USER_PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('USER_INACTIVE');

    const on = await request(ctx.app).patch(`/auth/users/${driver.id}`).set(boss.auth).send({ isActive: true });
    expect(on.body.user.isActive).toBe(true);
    expect((await request(ctx.app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: USER_PASSWORD })).status).toBe(200);
    // Repetir el mismo estado es idempotente.
    expect((await request(ctx.app).patch(`/auth/users/${driver.id}`).set(boss.auth).send({ isActive: true })).status).toBe(200);
  });

  test('el administrador no puede desactivarse a sí mismo (409) ni con un valor que no sea booleano (400)', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const self = await request(ctx.app).patch(`/auth/users/${boss.id}`).set(boss.auth).send({ isActive: false });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('CANNOT_DEACTIVATE_SELF');
    for (const isActive of ['false', 0, null, undefined]) {
      expect((await request(ctx.app).patch(`/auth/users/${boss.id}`).set(boss.auth).send({ isActive })).status).toBe(400);
    }
  });

  test('un repartidor con una ruta asignada o en curso no se puede desactivar (409)', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const driver = await createUser(ctx, boss.auth, 'carlos@correo.ficticio.com', 'repartidor', 'Carlos Conductor');
    ctx.repository.markActiveRoute(driver.id);
    const response = await request(ctx.app).patch(`/auth/users/${driver.id}`).set(boss.auth).send({ isActive: false });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('USER_HAS_ACTIVE_ROUTE');
    ctx.repository.markActiveRoute(driver.id, false);
    expect((await request(ctx.app).patch(`/auth/users/${driver.id}`).set(boss.auth).send({ isActive: false })).status).toBe(200);
  });

  test('el único administrador no se desactiva y no se puede crear un segundo (regla del repositorio)', async () => {
    const ctx = build();
    const first = await admin(ctx);
    await expect(admin(ctx, 'segundo@test.com')).rejects.toMatchObject({ code: 'ADMIN_ALREADY_EXISTS' });
    expect(await ctx.repository.setUserActive(first.id, false)).toBe('LAST_ADMIN');
    expect(await ctx.repository.setUserActive('11111111-1111-4111-8111-111111111111', false)).toBe('NOT_FOUND');
  });
});

describe('Registro de eventos de seguridad (en memoria)', () => {
  test('registra login, fallos, bloqueo, cambios de clave y acciones del admin sin exponer datos sensibles', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const user = await createUser(ctx, boss.auth, 'carlos@correo.ficticio.com', 'repartidor', 'Carlos Conductor');
    ctx.events.length = 0;

    await request(ctx.app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: 'ClaveIncorrecta9' });
    await request(ctx.app).post('/auth/login').send({ email: 'fantasma@correo.ficticio.com', password: 'ClaveIncorrecta9' });
    const ok = await request(ctx.app).post('/auth/login').send({ email: 'carlos@correo.ficticio.com', password: USER_PASSWORD });
    await request(ctx.app).post('/auth/change-password').set('Authorization', `Bearer ${ok.body.token}`).send({ currentPassword: USER_PASSWORD, newPassword: 'Nueva-Ruta-Sol-2027' });
    await request(ctx.app).patch(`/auth/users/${user.id}`).set(boss.auth).send({ isActive: false });

    const types = ctx.events.map((event) => event.type);
    expect(types).toEqual(['login_failed', 'login_failed', 'login_success', 'password_changed', 'user_deactivated']);
    expect(ctx.events[0]).toEqual({ type: 'login_failed', email: 'c***@correo.ficticio.com', userId: user.id, detail: 'wrong_password' });
    expect(ctx.events[1]).toEqual({ type: 'login_failed', email: 'f***@correo.ficticio.com', detail: 'unknown_account' });
    expect(ctx.events[4]).toEqual({ type: 'user_deactivated', userId: user.id, actorId: boss.id });
    const serialized = JSON.stringify(ctx.events);
    expect(serialized).not.toContain(USER_PASSWORD);
    expect(serialized).not.toContain('Nueva-Ruta-Sol-2027');
    expect(serialized).not.toContain('carlos@');
  });

  test('registra el bloqueo de cuenta, el registro, la verificación y la recuperación', async () => {
    const ctx = build();
    await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: 'Clave-Larga-Segura-2026' });
    expect(ctx.events.map((event) => event.type)).toEqual(['register']);

    const unverified = await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: 'Clave-Larga-Segura-2026' });
    expect(unverified.body.code).toBe('EMAIL_NOT_VERIFIED');
    const verificationCode = String(ctx.emails.lastCodeFor('ana@test.com'));
    await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code: verificationCode });

    await request(ctx.app).post('/auth/forgot-password').send({ email: 'ana@test.com' });
    const resetCode = String(ctx.emails.lastCodeFor('ana@test.com'));
    await request(ctx.app).post('/auth/reset-password').send({ email: 'ana@test.com', code: resetCode, newPassword: 'Otra-Clave-Larga-2027' });
    expect(ctx.events.map((event) => event.type)).toEqual(['register', 'login_unverified', 'email_verified', 'password_reset']);

    ctx.events.length = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: 'ClaveIncorrecta9' });
    }
    expect(ctx.events.map((event) => event.type)).toEqual(['login_failed', 'login_failed', 'login_failed', 'login_failed', 'login_failed', 'login_locked']);
    expect(ctx.events.every((event) => event.email === 'a***@test.com')).toBe(true);
    // No se busca "6 dígitos" en general: el UUID del usuario puede contener seis dígitos seguidos por azar.
    const serialized = JSON.stringify(ctx.events);
    expect(serialized).not.toContain(verificationCode);
    expect(serialized).not.toContain(resetCode);
  });

  test('un fallo del registro de eventos nunca rompe la petición', async () => {
    const repository = new InMemoryAuthRepository();
    const authModule = createAuthModule({ repository, jwtSecret: SECRET, emailSender: new CapturingEmailSender(), emailVerificationRequired: false, securityLog: () => { throw new Error('disco lleno'); } });
    const app = createApp({ webOrigin: 'http://127.0.0.1:5173', routers: [{ basePath: '/auth', router: authModule.router }], errorHandlers: [authModule.errorHandler] });
    const response = await request(app).post('/auth/register').send({ email: 'ana@test.com', password: 'Clave-Larga-Segura-2026' });
    expect(response.status).toBe(201);
  });
});

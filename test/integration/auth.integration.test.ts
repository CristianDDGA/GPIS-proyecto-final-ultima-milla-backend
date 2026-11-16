import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { createAuthModule } from '../../src/modules/auth/index.js';
import { CapturingEmailSender, InMemoryAuthRepository } from '../support/in-memory-auth.js';

const SECRET = 'integration-test-jwt-secret-1234';
const PASSWORD = 'ClaveSegura2026';

function build(options: { emailVerificationRequired?: boolean; now?: () => number; lockoutNow?: () => number } = {}) {
  const repository = new InMemoryAuthRepository(options.now);
  const emails = new CapturingEmailSender();
  const authModule = createAuthModule({
    repository,
    jwtSecret: SECRET,
    emailSender: emails,
    ...(options.lockoutNow ? { loginLockout: { maxFailures: 5, lockSeconds: 300, now: options.lockoutNow } } : {}),
    ...(options.emailVerificationRequired !== undefined ? { emailVerificationRequired: options.emailVerificationRequired } : {}),
  });
  const app = createApp({
    webOrigin: 'http://127.0.0.1:5173',
    tokenService: authModule.tokenService,
    tokenRevocationStore: authModule.revocationStore,
    routers: [{ basePath: '/auth', router: authModule.router }],
    errorHandlers: [authModule.errorHandler],
  });
  return { app, repository, emails, authModule };
}

async function adminToken(ctx: ReturnType<typeof build>): Promise<string> {
  await ctx.authModule.useCases.registerByAdmin(
    { role: 'personal' },
    { email: 'admin@test.com', password: 'Torre-Azul-Cobre-2026', role: 'admin', displayName: 'Administrador' },
  );
  const login = await request(ctx.app).post('/auth/login').send({ email: 'admin@test.com', password: 'Torre-Azul-Cobre-2026' });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

async function verifiedCustomer(ctx: ReturnType<typeof build>, email = 'ana@test.com') {
  await request(ctx.app).post('/auth/register').send({ email, password: PASSWORD, displayName: 'Ana Pérez' });
  const verify = await request(ctx.app).post('/auth/verify-email').send({ email, code: ctx.emails.lastCodeFor(email) });
  expect(verify.status).toBe(200);
  return verify.body as { token: string; user: { id: string } };
}

describe('Auth HTTP · registro y verificación de correo (en memoria)', () => {
  test('el registro de un cliente no devuelve token: exige verificar el correo y envía un código', async () => {
    const ctx = build();
    const response = await request(ctx.app).post('/auth/register').send({ email: 'Ana@Test.com', password: PASSWORD, displayName: 'Ana Pérez' });
    expect(response.status).toBe(201);
    expect(response.body.token).toBeUndefined();
    expect(response.body.verificationRequired).toBe(true);
    expect(response.body.user).toEqual(expect.objectContaining({ email: 'ana@test.com', role: 'cliente', emailVerified: false }));
    expect(ctx.emails.sent).toHaveLength(1);
    expect(ctx.emails.sent[0]!.to).toBe('ana@test.com');
    expect(ctx.emails.lastCodeFor('ana@test.com')).toMatch(/^\d{6}$/);
  });

  test('el correo duplicado responde 409', async () => {
    const ctx = build();
    await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    const duplicate = await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  test('sin verificar, el login con la clave correcta responde 403 EMAIL_NOT_VERIFIED; con clave mala sigue siendo 401', async () => {
    const ctx = build();
    await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    const unverified = await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: PASSWORD });
    expect(unverified.status).toBe(403);
    expect(unverified.body.code).toBe('EMAIL_NOT_VERIFIED');
    const wrong = await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: 'OtraClave999' });
    expect(wrong.status).toBe(401);
  });

  test('verify-email con el código correcto verifica la cuenta, abre sesión y el login funciona', async () => {
    const ctx = build();
    await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    const verify = await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code: ctx.emails.lastCodeFor('ana@test.com') });
    expect(verify.status).toBe(200);
    expect(verify.body.token).toEqual(expect.any(String));
    expect(verify.body.user.emailVerified).toBe(true);
    const me = await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${verify.body.token}`);
    expect(me.status).toBe(200);
    expect((await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: PASSWORD })).status).toBe(200);
  });

  test('el código es de un solo uso', async () => {
    const ctx = build();
    await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    const code = ctx.emails.lastCodeFor('ana@test.com');
    expect((await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code })).status).toBe(200);
    const again = await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_CODE');
  });

  test('un código incorrecto responde 400 INVALID_CODE y tras 5 fallos el código se invalida (429 CODE_LOCKED)', async () => {
    const ctx = build();
    await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    const real = ctx.emails.lastCodeFor('ana@test.com');
    const wrong = real === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code: wrong });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_CODE');
    }
    const locked = await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code: wrong });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('CODE_LOCKED');
    // El código correcto ya no sirve: hay que pedir otro.
    const afterLock = await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code: real });
    expect(afterLock.status).toBe(400);
  });

  test('un código caducado responde 400 CODE_EXPIRED', async () => {
    let clock = 1_000_000;
    const ctx = build({ now: () => clock });
    await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    const code = ctx.emails.lastCodeFor('ana@test.com');
    clock += 16 * 60_000;
    const expired = await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code });
    expect(expired.status).toBe(400);
    expect(expired.body.code).toBe('CODE_EXPIRED');
  });

  test('verify-email valida el formato (6 dígitos) y no revela si el correo existe', async () => {
    const ctx = build();
    expect((await request(ctx.app).post('/auth/verify-email').send({ email: 'ana@test.com', code: '12ab56' })).status).toBe(400);
    const unknown = await request(ctx.app).post('/auth/verify-email').send({ email: 'nadie@test.com', code: '123456' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('INVALID_CODE');
  });

  test('resend-verification responde 202 genérico, respeta el cooldown de 60 s y reenvía luego', async () => {
    let clock = 5_000_000;
    const ctx = build({ now: () => clock });
    await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    expect(ctx.emails.sent).toHaveLength(1);

    const early = await request(ctx.app).post('/auth/resend-verification').send({ email: 'ana@test.com' });
    expect(early.status).toBe(202);
    expect(ctx.emails.sent).toHaveLength(1);

    clock += 61_000;
    const later = await request(ctx.app).post('/auth/resend-verification').send({ email: 'ana@test.com' });
    expect(later.status).toBe(202);
    expect(ctx.emails.sent).toHaveLength(2);

    const unknown = await request(ctx.app).post('/auth/resend-verification').send({ email: 'nadie@test.com' });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(later.body);
    expect(ctx.emails.sent).toHaveLength(2);
  });

  test('si el SMTP falla, el registro igualmente responde 201 (el usuario puede reenviar el código)', async () => {
    const ctx = build();
    ctx.emails.failWith = new Error('SMTP caído');
    const response = await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    expect(response.status).toBe(201);
    expect(response.body.verificationRequired).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('SMTP');
  });

  test('modo demo (EMAIL_VERIFICATION_REQUIRED=false): el cliente nace verificado, recibe token y no se envía correo', async () => {
    const ctx = build({ emailVerificationRequired: false });
    const response = await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: PASSWORD });
    expect(response.status).toBe(201);
    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.user.emailVerified).toBe(true);
    expect(ctx.emails.sent).toHaveLength(0);
  });

  test('las cuentas creadas por un administrador (conductor, admin) nacen verificadas y entran sin código', async () => {
    const ctx = build();
    const token = await adminToken(ctx);
    const created = await request(ctx.app).post('/auth/users').set('Authorization', `Bearer ${token}`)
      .send({ email: 'conductor.demo@correo.ficticio.com', password: 'Ruta-Norte-Lluvia-2026', role: 'repartidor', displayName: 'Carlos Conductor' });
    expect(created.status).toBe(201);
    expect(created.body.user.emailVerified).toBe(true);
    expect(ctx.emails.sent).toHaveLength(0);
    const login = await request(ctx.app).post('/auth/login').send({ email: 'conductor.demo@correo.ficticio.com', password: 'Ruta-Norte-Lluvia-2026' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('repartidor');
  });
});

describe('Auth HTTP · login, sesión y administración (en memoria)', () => {
  test('POST /auth/login valida credenciales y GET /auth/me retorna perfil autenticado', async () => {
    const ctx = build();
    await verifiedCustomer(ctx, 'cliente2@test.com');
    const badLogin = await request(ctx.app).post('/auth/login').send({ email: 'cliente2@test.com', password: 'WrongPassword' });
    expect(badLogin.status).toBe(401);
    const login = await request(ctx.app).post('/auth/login').send({ email: 'cliente2@test.com', password: PASSWORD });
    expect(login.status).toBe(200);
    expect((await request(ctx.app).get('/auth/me')).status).toBe(401);
    const me = await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('cliente2@test.com');
  });

  test('POST /auth/users permite solo a admin crear repartidor/admin y rechaza clientes (403)', async () => {
    const ctx = build();
    const customer = await verifiedCustomer(ctx, 'cliente3@test.com');
    const forbidden = await request(ctx.app).post('/auth/users').set('Authorization', `Bearer ${customer.token}`)
      .send({ email: 'driver@test.com', password: 'Faro-Verde-Mar-2026', role: 'repartidor' });
    expect(forbidden.status).toBe(403);
    const token = await adminToken(ctx);
    const created = await request(ctx.app).post('/auth/users').set('Authorization', `Bearer ${token}`)
      .send({ email: 'driver@test.com', password: 'Faro-Verde-Mar-2026', role: 'repartidor', displayName: 'Conductor Uno' });
    expect(created.status).toBe(201);
    expect(created.body.user.role).toBe('repartidor');
  });

  test('POST /auth/logout revoca el token actual e impide reutilizarlo (401)', async () => {
    const ctx = build();
    const { token } = await verifiedCustomer(ctx, 'logout-user@test.com');
    expect((await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const logout = await request(ctx.app).post('/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ ok: true });
    expect((await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(ctx.app).post('/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
});

describe('Auth HTTP · recuperación y cambio de clave (en memoria)', () => {
  test('olvidé mi clave: código por correo, nueva clave, sesiones anteriores cerradas y login con la nueva', async () => {
    let clock = 10_000_000;
    const ctx = build({ now: () => clock });
    const session = await verifiedCustomer(ctx);
    // Las sesiones se invalidan por segundo de emisión: se espera a que el reloj real avance.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    clock += 120_000;

    const forgot = await request(ctx.app).post('/auth/forgot-password').send({ email: 'ana@test.com' });
    expect(forgot.status).toBe(202);
    const code = ctx.emails.lastCodeFor('ana@test.com');
    expect(ctx.emails.sent.at(-1)!.subject).toContain('recuperar');

    const reset = await request(ctx.app).post('/auth/reset-password').send({ email: 'ana@test.com', code, newPassword: 'NuevaClave456' });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ ok: true });

    expect((await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${session.token}`)).status).toBe(401);
    expect((await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: PASSWORD })).status).toBe(401);
    expect((await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: 'NuevaClave456' })).status).toBe(200);
    // El código ya se consumió.
    const reuse = await request(ctx.app).post('/auth/reset-password').send({ email: 'ana@test.com', code, newPassword: 'OtraClave789' });
    expect(reuse.status).toBe(400);
  });

  test('forgot-password responde igual (202) exista o no la cuenta y no envía correo a cuentas sin verificar por código', async () => {
    const ctx = build();
    const unknown = await request(ctx.app).post('/auth/forgot-password').send({ email: 'nadie@test.com' });
    await verifiedCustomer(ctx);
    ctx.emails.sent.length = 0;
    const known = await request(ctx.app).post('/auth/forgot-password').send({ email: 'ana@test.com' });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(ctx.emails.sent).toHaveLength(1);

    // Un conductor creado por el admin (correo ficticio) no recibe códigos de recuperación.
    const token = await adminToken(ctx);
    await request(ctx.app).post('/auth/users').set('Authorization', `Bearer ${token}`)
      .send({ email: 'conductor@ficticio.com', password: 'Ruta-Norte-Lluvia-2026', role: 'repartidor' });
    ctx.emails.sent.length = 0;
    expect((await request(ctx.app).post('/auth/forgot-password').send({ email: 'conductor@ficticio.com' })).status).toBe(202);
    expect(ctx.emails.sent).toHaveLength(0);
  });

  test('reset-password con código incorrecto, clave débil o correo desconocido responde 400', async () => {
    const ctx = build();
    await verifiedCustomer(ctx);
    await request(ctx.app).post('/auth/forgot-password').send({ email: 'ana@test.com' });
    const bad = await request(ctx.app).post('/auth/reset-password').send({ email: 'ana@test.com', code: '000000', newPassword: 'NuevaClave456' });
    expect([400]).toContain(bad.status);
    expect((await request(ctx.app).post('/auth/reset-password').send({ email: 'ana@test.com', code: ctx.emails.lastCodeFor('ana@test.com'), newPassword: 'corta' })).status).toBe(400);
    const unknown = await request(ctx.app).post('/auth/reset-password').send({ email: 'nadie@test.com', code: '123456', newPassword: 'NuevaClave456' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('INVALID_CODE');
  });

  test('change-password exige la clave actual, cierra las otras sesiones y devuelve una sesión nueva', async () => {
    const ctx = build();
    const first = await verifiedCustomer(ctx);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: PASSWORD });
    const auth = { Authorization: `Bearer ${second.body.token}` };

    expect((await request(ctx.app).post('/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'NuevaClave456' })).status).toBe(401);
    const wrong = await request(ctx.app).post('/auth/change-password').set(auth).send({ currentPassword: 'Incorrecta999', newPassword: 'NuevaClave456' });
    expect(wrong.status).toBe(400);
    const same = await request(ctx.app).post('/auth/change-password').set(auth).send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const changed = await request(ctx.app).post('/auth/change-password').set(auth).send({ currentPassword: PASSWORD, newPassword: 'NuevaClave456' });
    expect(changed.status).toBe(200);
    expect(changed.body.token).toEqual(expect.any(String));

    expect((await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${first.token}`)).status).toBe(401);
    expect((await request(ctx.app).get('/auth/me').set(auth)).status).toBe(401);
    expect((await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${changed.body.token}`)).status).toBe(200);
    expect((await request(ctx.app).post('/auth/login').send({ email: 'ana@test.com', password: 'NuevaClave456' })).status).toBe(200);
  });

  test('el admin restablece la clave de un conductor; clientes y conductores no pueden', async () => {
    const ctx = build();
    const token = await adminToken(ctx);
    const driver = await request(ctx.app).post('/auth/users').set('Authorization', `Bearer ${token}`)
      .send({ email: 'conductor@ficticio.com', password: 'Ruta-Norte-Lluvia-2026', role: 'repartidor', displayName: 'Carlos Conductor' });
    const driverId = driver.body.user.id as string;
    const driverSession = await request(ctx.app).post('/auth/login').send({ email: 'conductor@ficticio.com', password: 'Ruta-Norte-Lluvia-2026' });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const byDriver = await request(ctx.app).post(`/auth/users/${driverId}/reset-password`).set('Authorization', `Bearer ${driverSession.body.token}`).send({ newPassword: 'ClaveNueva789' });
    expect(byDriver.status).toBe(403);

    const ok = await request(ctx.app).post(`/auth/users/${driverId}/reset-password`).set('Authorization', `Bearer ${token}`).send({ newPassword: 'ClaveNueva789' });
    expect(ok.status).toBe(200);
    expect((await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${driverSession.body.token}`)).status).toBe(401);
    expect((await request(ctx.app).post('/auth/login').send({ email: 'conductor@ficticio.com', password: 'ClaveNueva789' })).status).toBe(200);

    const missing = await request(ctx.app).post('/auth/users/11111111-1111-4111-8111-111111111111/reset-password').set('Authorization', `Bearer ${token}`).send({ newPassword: 'ClaveNueva789' });
    expect(missing.status).toBe(404);
    expect((await request(ctx.app).post('/auth/users/no-es-uuid/reset-password').set('Authorization', `Bearer ${token}`).send({ newPassword: 'ClaveNueva789' })).status).toBe(400);
  });
});

describe('Auth HTTP · bloqueo por cuenta y política de contraseñas (en memoria)', () => {
  const loginWith = (ctx: ReturnType<typeof build>, email: string, password: string) =>
    request(ctx.app).post('/auth/login').send({ email, password });

  test('5 fallos bloquean la cuenta 5 minutos: 429 ACCOUNT_LOCKED con Retry-After, incluso con la clave correcta', async () => {
    let clock = 50_000_000;
    const ctx = build({ lockoutNow: () => clock });
    await verifiedCustomer(ctx);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await loginWith(ctx, 'ana@test.com', 'ClaveIncorrecta9')).status).toBe(401);
    }
    const locked = await loginWith(ctx, 'ana@test.com', PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBe(300);

    clock += 100_000;
    expect(Number((await loginWith(ctx, 'ana@test.com', PASSWORD)).headers['retry-after'])).toBe(200);

    clock += 201_000;
    expect((await loginWith(ctx, 'ana@test.com', PASSWORD)).status).toBe(200);
  });

  test('un login correcto reinicia el contador de fallos', async () => {
    const ctx = build({ lockoutNow: () => 60_000_000 });
    await verifiedCustomer(ctx);
    for (let round = 0; round < 3; round += 1) {
      for (let attempt = 0; attempt < 4; attempt += 1) await loginWith(ctx, 'ana@test.com', 'ClaveIncorrecta9');
      expect((await loginWith(ctx, 'ana@test.com', PASSWORD)).status).toBe(200);
    }
  });

  test('el bloqueo es por cuenta y también cuenta correos inexistentes (no revela qué cuentas existen)', async () => {
    const ctx = build({ lockoutNow: () => 70_000_000 });
    await verifiedCustomer(ctx);
    await verifiedCustomer(ctx, 'luis@test.com');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginWith(ctx, 'ana@test.com', 'ClaveIncorrecta9');
      await loginWith(ctx, 'fantasma@test.com', 'ClaveIncorrecta9');
    }
    expect((await loginWith(ctx, 'ana@test.com', PASSWORD)).status).toBe(429);
    const ghost = await loginWith(ctx, 'fantasma@test.com', PASSWORD);
    expect(ghost.status).toBe(429);
    expect(ghost.body.code).toBe('ACCOUNT_LOCKED');
    expect((await loginWith(ctx, 'luis@test.com', PASSWORD)).status).toBe(200);
  });

  test('las contraseñas comunes o predecibles se rechazan al registrar, cambiar y restablecer', async () => {
    const ctx = build();
    for (const weak of ['Password123', 'password', '12345678', 'qwerty123', 'aaaaaaaaaa', 'Admin#2026', 'ana.perez2026']) {
      const response = await request(ctx.app).post('/auth/register').send({ email: 'ana.perez@test.com', password: weak });
      expect([weak, response.status]).toEqual([weak, 400]);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    }
    const session = await verifiedCustomer(ctx);
    const change = await request(ctx.app).post('/auth/change-password').set('Authorization', `Bearer ${session.token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'Password123' });
    expect(change.status).toBe(400);
    expect(change.body.message).toMatch(/común|fácil/);

    await request(ctx.app).post('/auth/forgot-password').send({ email: 'ana@test.com' });
    const reset = await request(ctx.app).post('/auth/reset-password')
      .send({ email: 'ana@test.com', code: ctx.emails.lastCodeFor('ana@test.com'), newPassword: '12345678' });
    expect(reset.status).toBe(400);
  });

  test('una contraseña larga y única se acepta', async () => {
    const ctx = build();
    const response = await request(ctx.app).post('/auth/register').send({ email: 'ana@test.com', password: 'mi gato come atún los jueves' });
    expect(response.status).toBe(201);
  });
});

import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { createAuthModule } from '../../src/modules/auth/index.js';
import type { SecurityEvent } from '../../src/modules/auth/application/ports/security-log.port.js';
import { createCourierApplicationsModule } from '../../src/modules/courier-applications/index.js';
import { InMemoryFileStorage } from '../../src/modules/courier-applications/infrastructure/storage/in-memory-file-storage.js';
import { CapturingEmailSender, InMemoryAuthRepository } from '../support/in-memory-auth.js';
import { InMemoryApplicationRepository } from '../support/in-memory-applications.js';

const SECRET = 'integration-test-jwt-secret-1234';
const ADMIN_PASSWORD = 'Torre-Azul-Cobre-2026';
const USER_PASSWORD = 'Faro-Verde-Mar-2026';
const TODAY = '2026-11-16';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('imagen-de-prueba')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('imagen-de-prueba')]);

const VALID_FORM = {
  fullName: 'Carlos Andrade Mora',
  nationalId: '1712345675',
  phone: '0991234567',
  birthDate: '1995-04-20',
  vehicleType: 'moto',
  licenseNumber: 'ec-123456',
  licenseCategory: 'a',
  licenseExpiresOn: '2030-01-31',
};

function build() {
  const authRepository = new InMemoryAuthRepository();
  const emails = new CapturingEmailSender();
  const events: SecurityEvent[] = [];
  const storage = new InMemoryFileStorage();
  const securityLog = (event: SecurityEvent) => { events.push(event); };
  // Modo demo: los clientes nacen verificados, como en k6 y ZAP.
  const authModule = createAuthModule({
    repository: authRepository,
    jwtSecret: SECRET,
    emailSender: emails,
    emailVerificationRequired: false,
    securityLog,
  });
  const applications = new InMemoryApplicationRepository(authRepository, () => TODAY);
  const applicationsModule = createCourierApplicationsModule({
    repository: applications,
    storage,
    revocationStore: authModule.revocationStore,
    emailSender: emails,
    securityLog,
    today: () => TODAY,
  });
  const app = createApp({
    webOrigin: 'http://127.0.0.1:5173',
    tokenService: authModule.tokenService,
    tokenRevocationStore: authModule.revocationStore,
    routers: [
      { basePath: '/auth', router: authModule.router },
      { basePath: '/courier-applications', router: applicationsModule.router },
    ],
    errorHandlers: [authModule.errorHandler, applicationsModule.errorHandler],
  });
  return { app, authRepository, authModule, applicationsModule, emails, events, storage };
}
type Ctx = ReturnType<typeof build>;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function admin(ctx: Ctx) {
  const user = await ctx.authModule.useCases.registerByAdmin({ role: 'personal' }, { email: 'admin@test.com', password: ADMIN_PASSWORD, role: 'admin', displayName: 'Administrador Principal' });
  const login = await request(ctx.app).post('/auth/login').send({ email: 'admin@test.com', password: ADMIN_PASSWORD });
  return { id: user.id, token: login.body.token as string, auth: bearer(login.body.token) };
}

async function customer(ctx: Ctx, email = 'carlos@test.com') {
  const register = await request(ctx.app).post('/auth/register').send({ email, password: USER_PASSWORD, displayName: 'Carlos Andrade' });
  expect(register.status).toBe(201);
  return { id: register.body.user.id as string, token: register.body.token as string, auth: bearer(register.body.token), email };
}

async function submitted(ctx: Ctx, email = 'carlos@test.com', form: Record<string, unknown> = VALID_FORM) {
  const client = await customer(ctx, email);
  expect((await request(ctx.app).put('/courier-applications/me').set(client.auth).send(form)).status).toBe(200);
  for (const [kind, body, type] of [['license', JPEG, 'image/jpeg'], ['photo', PNG, 'image/png']] as const) {
    const upload = await request(ctx.app).put(`/courier-applications/me/files/${kind}`).set(client.auth).set('Content-Type', type).send(body);
    expect(upload.status).toBe(200);
  }
  const submit = await request(ctx.app).post('/courier-applications/me/submit').set(client.auth);
  expect(submit.status).toBe(200);
  return { client, applicationId: submit.body.application.id as string };
}

describe('Solicitud de conductor · cliente (en memoria)', () => {
  test('guarda el borrador normalizado, lo actualiza y no expone nada ajeno', async () => {
    const ctx = build();
    const client = await customer(ctx);
    const empty = await request(ctx.app).get('/courier-applications/me').set(client.auth);
    expect(empty.status).toBe(200);
    expect(empty.body.application).toBeNull();

    const saved = await request(ctx.app).put('/courier-applications/me').set(client.auth).send(VALID_FORM);
    expect(saved.status).toBe(200);
    expect(saved.body.application).toEqual(expect.objectContaining({
      status: 'borrador', fullName: 'Carlos Andrade Mora', licenseNumber: 'EC-123456', licenseCategory: 'A', files: [], userId: client.id,
    }));

    const updated = await request(ctx.app).put('/courier-applications/me').set(client.auth).send({ ...VALID_FORM, phone: '+593 99 123 4567' });
    expect(updated.status).toBe(200);
    expect(updated.body.application.phone).toBe('+593991234567');
    expect(updated.body.application.id).toBe(saved.body.application.id);
  });

  test.each([
    ['nombre con emoji', { fullName: 'Carlos 😀 Mora' }],
    ['nombre de una sola palabra', { fullName: 'Carlos' }],
    ['cédula corta', { nationalId: '12345' }],
    ['teléfono con letras', { phone: '09912abc' }],
    ['menor de edad', { birthDate: '2015-01-01' }],
    ['fecha inexistente', { birthDate: '1995-02-31' }],
    ['vehículo no permitido', { vehicleType: 'avion' }],
    ['categoría inexistente', { licenseCategory: 'Z' }],
    ['licencia caducada', { licenseExpiresOn: '2020-01-01' }],
    ['licencia que caduca hoy', { licenseExpiresOn: TODAY }],
    ['número de licencia con símbolos', { licenseNumber: 'AB<script>' }],
  ])('rechaza con 400 un formulario inválido: %s', async (_name, change) => {
    const ctx = build();
    const client = await customer(ctx);
    const response = await request(ctx.app).put('/courier-applications/me').set(client.auth).send({ ...VALID_FORM, ...change });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect((await request(ctx.app).get('/courier-applications/me').set(client.auth)).body.application).toBeNull();
  });

  test('un campo ausente o un cuerpo que no es objeto responde 400', async () => {
    const ctx = build();
    const client = await customer(ctx);
    const { nationalId: _omit, ...incomplete } = VALID_FORM;
    expect((await request(ctx.app).put('/courier-applications/me').set(client.auth).send(incomplete)).status).toBe(400);
    expect((await request(ctx.app).put('/courier-applications/me').set(client.auth).send([])).status).toBe(400);
  });

  test('un cliente con el correo sin verificar no puede solicitar (403 EMAIL_NOT_VERIFIED)', async () => {
    const ctx = build();
    const user = await ctx.authRepository.registerUser({
      authSubject: 'sin-verificar@test.com',
      email: 'sin-verificar@test.com',
      passwordHash: 'hash',
      role: 'cliente',
      displayName: 'Sin Verificar',
      verification: 'pending',
    });
    await expect(ctx.applicationsModule.useCases.saveDraft({ id: user.id, role: 'cliente' }, VALID_FORM)).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  test('subida de imágenes: solo JPEG/PNG reales, hasta 5 MB, y reemplazar borra la anterior', async () => {
    const ctx = build();
    const client = await customer(ctx);
    const put = (kind: string, type: string, body: Buffer | string) =>
      request(ctx.app).put(`/courier-applications/me/files/${kind}`).set(client.auth).set('Content-Type', type).send(body);

    // Sin borrador todavía.
    expect((await put('license', 'image/jpeg', JPEG)).body.code).toBe('NO_OPEN_APPLICATION');
    await request(ctx.app).put('/courier-applications/me').set(client.auth).send(VALID_FORM);

    expect((await put('license', 'text/plain', 'hola')).status).toBe(415);
    expect((await put('license', 'application/json', '{}')).status).toBe(415);
    // El Content-Type dice imagen pero el contenido no lo es.
    expect((await put('license', 'image/png', 'esto no es una imagen')).status).toBe(415);
    expect((await put('license', 'image/jpeg', Buffer.alloc(0))).status).toBe(400);
    expect((await put('cedula', 'image/jpeg', JPEG)).status).toBe(400);
    const tooLarge = await put('license', 'image/jpeg', Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.code).toBe('FILE_TOO_LARGE');
    expect(ctx.storage.size).toBe(0);

    const first = await put('license', 'image/jpeg', JPEG);
    expect(first.status).toBe(200);
    expect(first.body.application.files).toEqual([expect.objectContaining({ kind: 'license', contentType: 'image/jpeg', sizeBytes: JPEG.length })]);
    expect(ctx.storage.size).toBe(1);
    const second = await put('license', 'image/png', PNG);
    expect(second.status).toBe(200);
    expect(second.body.application.files).toEqual([expect.objectContaining({ kind: 'license', contentType: 'image/png' })]);
    expect(ctx.storage.size).toBe(1);

    // El dueño puede ver lo que subió, sin que el navegador lo ejecute.
    const mine = await request(ctx.app).get('/courier-applications/me/files/license').set(client.auth);
    expect(mine.status).toBe(200);
    expect(mine.headers['content-type']).toBe('image/png');
    expect(mine.headers['content-security-policy']).toContain("default-src 'none'");
    expect(mine.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(mine.body as Buffer).equals(PNG)).toBe(true);
    expect((await request(ctx.app).get('/courier-applications/me/files/photo').set(client.auth)).status).toBe(404);
  });

  test('enviar exige las dos imágenes; luego queda pendiente y no se puede editar ni repetir', async () => {
    const ctx = build();
    const client = await customer(ctx);
    expect((await request(ctx.app).post('/courier-applications/me/submit').set(client.auth)).body.code).toBe('NO_OPEN_APPLICATION');
    await request(ctx.app).put('/courier-applications/me').set(client.auth).send(VALID_FORM);
    await request(ctx.app).put('/courier-applications/me/files/license').set(client.auth).set('Content-Type', 'image/jpeg').send(JPEG);
    const incomplete = await request(ctx.app).post('/courier-applications/me/submit').set(client.auth);
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.code).toBe('MISSING_FILES');
    await request(ctx.app).put('/courier-applications/me/files/photo').set(client.auth).set('Content-Type', 'image/png').send(PNG);

    const sent = await request(ctx.app).post('/courier-applications/me/submit').set(client.auth);
    expect(sent.status).toBe(200);
    expect(sent.body.application.status).toBe('pendiente');
    expect(sent.body.application.submittedAt).toEqual(expect.any(String));
    expect(ctx.events.map((event) => event.type)).toContain('courier_application_submitted');

    expect((await request(ctx.app).put('/courier-applications/me').set(client.auth).send(VALID_FORM)).body.code).toBe('ALREADY_PENDING');
    expect((await request(ctx.app).put('/courier-applications/me/files/photo').set(client.auth).set('Content-Type', 'image/png').send(PNG)).body.code).toBe('NO_OPEN_APPLICATION');
    expect((await request(ctx.app).post('/courier-applications/me/submit').set(client.auth)).body.code).toBe('NO_OPEN_APPLICATION');
  });

  test('una cédula ya usada en otra solicitud vigente se rechaza (409)', async () => {
    const ctx = build();
    await submitted(ctx, 'uno@test.com');
    const other = await customer(ctx, 'dos@test.com');
    const response = await request(ctx.app).put('/courier-applications/me').set(other.auth).send(VALID_FORM);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('DUPLICATE_NATIONAL_ID');
  });

  test('el cliente cancela su solicitud (pendiente o borrador) y puede empezar otra', async () => {
    const ctx = build();
    const { client } = await submitted(ctx);
    const cancelled = await request(ctx.app).post('/courier-applications/me/cancel').set(client.auth);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.application.status).toBe('cancelada');
    expect((await request(ctx.app).post('/courier-applications/me/cancel').set(client.auth)).body.code).toBe('NO_OPEN_APPLICATION');
    const again = await request(ctx.app).put('/courier-applications/me').set(client.auth).send(VALID_FORM);
    expect(again.status).toBe(200);
    expect(again.body.application.status).toBe('borrador');
    expect(again.body.application.files).toEqual([]);
  });
});

describe('Solicitud de conductor · permisos (en memoria)', () => {
  test('sin token 401; cada rol solo entra a lo suyo (403)', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const client = await customer(ctx);
    await ctx.authModule.useCases.registerByAdmin({ role: 'personal' }, { email: 'conductor@correo.ficticio.com', password: USER_PASSWORD, role: 'repartidor', displayName: 'Pedro Conductor' });
    const driverLogin = await request(ctx.app).post('/auth/login').send({ email: 'conductor@correo.ficticio.com', password: USER_PASSWORD });
    const driver = bearer(driverLogin.body.token);
    expect(driverLogin.status).toBe(200);

    for (const [method, path] of [['get', '/courier-applications/me'], ['get', '/courier-applications'], ['post', '/courier-applications/me/submit']] as const) {
      expect((await request(ctx.app)[method](path)).status).toBe(401);
    }
    // Repartidor y administrador no tienen solicitud propia.
    for (const auth of [driver, boss.auth]) {
      expect((await request(ctx.app).get('/courier-applications/me').set(auth)).status).toBe(403);
      expect((await request(ctx.app).put('/courier-applications/me').set(auth).send(VALID_FORM)).status).toBe(403);
    }
    // Cliente y repartidor no revisan.
    for (const auth of [client.auth, driver]) {
      expect((await request(ctx.app).get('/courier-applications').set(auth)).status).toBe(403);
      expect((await request(ctx.app).get('/courier-applications/11111111-1111-4111-8111-111111111111').set(auth)).status).toBe(403);
      expect((await request(ctx.app).post('/courier-applications/11111111-1111-4111-8111-111111111111/approve').set(auth)).status).toBe(403);
      expect((await request(ctx.app).post('/courier-applications/11111111-1111-4111-8111-111111111111/reject').set(auth).send({ reason: 'No cumple' })).status).toBe(403);
      expect((await request(ctx.app).get('/courier-applications/11111111-1111-4111-8111-111111111111/files/license').set(auth)).status).toBe(403);
    }
  });
});

describe('Solicitud de conductor · revisión del administrador (en memoria)', () => {
  test('lista con filtros y paginación, abre el detalle y ve las imágenes; los borradores no aparecen', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const first = await submitted(ctx, 'uno@test.com');
    await submitted(ctx, 'dos@test.com', { ...VALID_FORM, nationalId: '1723456784', fullName: 'María Torres Vega' });
    const draftOnly = await customer(ctx, 'tres@test.com');
    await request(ctx.app).put('/courier-applications/me').set(draftOnly.auth).send({ ...VALID_FORM, nationalId: '1711111110' });

    const all = await request(ctx.app).get('/courier-applications').set(boss.auth);
    expect(all.status).toBe(200);
    expect(all.body).toEqual(expect.objectContaining({ total: 2, limit: 25, offset: 0 }));
    expect(all.body.items[0]).toEqual(expect.objectContaining({ status: 'pendiente', applicantEmail: expect.any(String) }));
    expect((await request(ctx.app).get('/courier-applications?q=TORRES').set(boss.auth)).body.total).toBe(1);
    expect((await request(ctx.app).get('/courier-applications?q=1723456784').set(boss.auth)).body.total).toBe(1);
    expect((await request(ctx.app).get('/courier-applications?status=aprobada').set(boss.auth)).body.total).toBe(0);
    expect((await request(ctx.app).get('/courier-applications?limit=1&offset=1').set(boss.auth)).body.items).toHaveLength(1);
    for (const bad of ['status=borrador', 'status=xx', 'limit=0', 'limit=101', 'offset=-1']) {
      expect((await request(ctx.app).get(`/courier-applications?${bad}`).set(boss.auth)).status).toBe(400);
    }

    const detail = await request(ctx.app).get(`/courier-applications/${first.applicationId}`).set(boss.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.application).toEqual(expect.objectContaining({ id: first.applicationId, nationalId: '1712345675', applicantEmail: 'uno@test.com' }));
    expect(detail.body.application.files).toHaveLength(2);
    const license = await request(ctx.app).get(`/courier-applications/${first.applicationId}/files/license`).set(boss.auth);
    expect(license.status).toBe(200);
    expect(license.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(license.body as Buffer).equals(JPEG)).toBe(true);

    const draftId = (await ctx.applicationsModule.useCases.getMine({ id: draftOnly.id, role: 'cliente' }))!.id;
    expect((await request(ctx.app).get(`/courier-applications/${draftId}`).set(boss.auth)).status).toBe(404);
    expect((await request(ctx.app).get(`/courier-applications/${draftId}/files/license`).set(boss.auth)).status).toBe(404);
    expect((await request(ctx.app).get('/courier-applications/no-es-uuid').set(boss.auth)).status).toBe(400);
    expect((await request(ctx.app).get('/courier-applications/11111111-1111-4111-8111-111111111111').set(boss.auth)).status).toBe(404);
  });

  test('aprobar convierte al cliente en conductor: cierra su sesión, entra con rol repartidor y recibe un correo', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const { client, applicationId } = await submitted(ctx);
    await sleep(1100); // el cierre de sesiones corta los tokens emitidos en segundos anteriores

    const approved = await request(ctx.app).post(`/courier-applications/${applicationId}/approve`).set(boss.auth).send({ capacity: 12 });
    expect(approved.status).toBe(200);
    expect(approved.body.application).toEqual(expect.objectContaining({ status: 'aprobada', approvedCapacity: 12, reviewedAt: expect.any(String) }));

    // La sesión anterior (rol cliente) ya no sirve.
    expect((await request(ctx.app).get('/auth/me').set(client.auth)).status).toBe(401);
    expect((await request(ctx.app).get('/courier-applications/me').set(client.auth)).status).toBe(401);

    const login = await request(ctx.app).post('/auth/login').send({ email: client.email, password: USER_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user).toEqual(expect.objectContaining({ role: 'repartidor', publicRole: 'repartidor', courierId: expect.any(String) }));
    const me = await request(ctx.app).get('/auth/me').set(bearer(login.body.token));
    expect(me.body.user.role).toBe('repartidor');
    // Ya no es cliente: su panel de solicitud deja de estar disponible.
    expect((await request(ctx.app).get('/courier-applications/me').set(bearer(login.body.token))).status).toBe(403);

    expect(ctx.emails.sent.some((message) => message.to === client.email && message.subject.includes('aprobada'))).toBe(true);
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: 'courier_application_approved', userId: client.id, actorId: boss.id, email: 'c***@test.com' }));
    expect(JSON.stringify(ctx.events)).not.toContain('1712345675');

    // Ya resuelta: no se aprueba ni se rechaza de nuevo.
    expect((await request(ctx.app).post(`/courier-applications/${applicationId}/approve`).set(boss.auth)).body.code).toBe('NOT_PENDING');
    expect((await request(ctx.app).post(`/courier-applications/${applicationId}/reject`).set(boss.auth).send({ reason: 'Tarde' })).body.code).toBe('NOT_PENDING');
  });

  test('aprobar usa la capacidad por defecto y valida la capacidad enviada', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const { applicationId } = await submitted(ctx);
    for (const capacity of [0, -1, 1.5, '10', 201]) {
      const response = await request(ctx.app).post(`/courier-applications/${applicationId}/approve`).set(boss.auth).send({ capacity });
      expect(response.status).toBe(400);
    }
    const ok = await request(ctx.app).post(`/courier-applications/${applicationId}/approve`).set(boss.auth);
    expect(ok.status).toBe(200);
    expect(ok.body.application.approvedCapacity).toBe(10);
  });

  test('rechazar exige un motivo; el cliente lo ve y puede enviar una solicitud nueva', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const { client, applicationId } = await submitted(ctx);

    for (const body of [{}, { reason: '' }, { reason: 'No' }, { reason: 42 }, { reason: 'x'.repeat(501) }, { reason: 'Foto borrosa 😀' }, { reason: 'Foto <b>borrosa</b>' }, { reason: `Foto borrosa ${String.fromCharCode(0)}` }, { reason: 'Foto borrosa; DROP <TABLE>' }]) {
      expect((await request(ctx.app).post(`/courier-applications/${applicationId}/reject`).set(boss.auth).send(body)).status).toBe(400);
    }
    const rejected = await request(ctx.app).post(`/courier-applications/${applicationId}/reject`).set(boss.auth).send({ reason: '  La foto de la licencia no se lee.  ' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.application).toEqual(expect.objectContaining({ status: 'rechazada', rejectionReason: 'La foto de la licencia no se lee.' }));
    expect(ctx.emails.sent.find((message) => message.subject.includes('rechazada'))?.text).toContain('La foto de la licencia no se lee.');
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: 'courier_application_rejected', actorId: boss.id }));

    // Sigue siendo cliente y con la misma sesión: ve el motivo y puede intentarlo otra vez.
    const mine = await request(ctx.app).get('/courier-applications/me').set(client.auth);
    expect(mine.body.application).toEqual(expect.objectContaining({ status: 'rechazada', rejectionReason: 'La foto de la licencia no se lee.' }));
    expect((await request(ctx.app).get('/auth/me').set(client.auth)).body.user.role).toBe('cliente');
    const retry = await request(ctx.app).put('/courier-applications/me').set(client.auth).send(VALID_FORM);
    expect(retry.status).toBe(200);
    expect(retry.body.application).toEqual(expect.objectContaining({ status: 'borrador', files: [] }));
    expect(retry.body.application.id).not.toBe(applicationId);
  });

  test('si el correo falla la decisión igualmente queda guardada', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const { applicationId } = await submitted(ctx);
    ctx.emails.failWith = new Error('SMTP caído');
    const response = await request(ctx.app).post(`/courier-applications/${applicationId}/approve`).set(boss.auth);
    expect(response.status).toBe(200);
    expect(response.body.application.status).toBe('aprobada');
  });

  test('un solicitante que dejó de ser cliente ya no puede aprobarse (409)', async () => {
    const ctx = build();
    const boss = await admin(ctx);
    const { client, applicationId } = await submitted(ctx);
    ctx.authRepository.promoteToCourier(client.id, 'Carlos Andrade');
    const response = await request(ctx.app).post(`/courier-applications/${applicationId}/approve`).set(boss.auth);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('APPLICANT_NOT_CLIENT');
  });
});

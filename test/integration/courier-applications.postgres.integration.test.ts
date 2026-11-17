import request from 'supertest';
import { createPersistedApp } from '../../src/bootstrap/create-persisted-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { InMemoryFileStorage } from '../../src/modules/courier-applications/infrastructure/storage/in-memory-file-storage.js';
import { CapturingEmailSender } from '../support/in-memory-auth.js';
import { realDatabase } from './database.fixture.js';
import { createFixtureActor, deliveryDatabase, resetTestData, runAdminSql } from './sprint03/deliveries.fixture.js';

const SECRET = 'integration-test-jwt-secret-1234';
const ORIGIN = 'http://127.0.0.1:5173';
const USER_PASSWORD = 'Faro-Verde-Mar-2026';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('imagen-de-prueba')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('imagen-de-prueba')]);

const VALID_FORM = {
  fullName: 'Carlos Andrade Mora',
  nationalId: '1712345675',
  phone: '0991234567',
  birthDate: '1995-04-20',
  vehicleType: 'moto',
  licenseNumber: 'EC-123456',
  licenseCategory: 'A',
  licenseExpiresOn: '2099-01-31',
};

const describeReal = realDatabase ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeReal('Solicitud de conductor · PostgreSQL real (migración 009)', () => {
  let database: ReturnType<typeof deliveryDatabase>;
  let app: ReturnType<typeof createPersistedApp>;
  let storage: InMemoryFileStorage;
  let emails: CapturingEmailSender;
  const tokens = new HmacJwtTokenService(SECRET);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(() => { database = deliveryDatabase(); });
  beforeEach(() => {
    resetTestData();
    storage = new InMemoryFileStorage();
    emails = new CapturingEmailSender();
    // Modo demo: los clientes nacen con el correo verificado.
    app = createPersistedApp(database, ORIGIN, { jwtSecret: SECRET, emailSender: emails, emailVerificationRequired: false, fileStorage: storage });
  });
  afterAll(async () => { await database?.$disconnect(); });

  function adminAuth() {
    const actor = createFixtureActor('personal');
    return { id: actor.actorId, auth: bearer(tokens.sign({ sub: actor.actorId, role: 'personal', authSubject: actor.authSubject, courierId: null })) };
  }

  async function customer(email: string) {
    const response = await request(app).post('/auth/register').send({ email, password: USER_PASSWORD, displayName: 'Carlos Andrade' });
    expect(response.status).toBe(201);
    return { id: response.body.user.id as string, token: response.body.token as string, auth: bearer(response.body.token), email };
  }

  async function submitted(email: string, form: Record<string, unknown> = VALID_FORM) {
    const client = await customer(email);
    expect((await request(app).put('/courier-applications/me').set(client.auth).send(form)).status).toBe(200);
    expect((await request(app).put('/courier-applications/me/files/license').set(client.auth).set('Content-Type', 'image/jpeg').send(JPEG)).status).toBe(200);
    expect((await request(app).put('/courier-applications/me/files/photo').set(client.auth).set('Content-Type', 'image/png').send(PNG)).status).toBe(200);
    const submit = await request(app).post('/courier-applications/me/submit').set(client.auth);
    expect(submit.status).toBe(200);
    return { client, applicationId: submit.body.application.id as string };
  }

  it('flujo completo: el cliente solicita, el administrador aprueba y la cuenta pasa a conductor con su ficha', async () => {
    const boss = adminAuth();
    const { client, applicationId } = await submitted('carlos@test.com');
    expect(runAdminSql(`SELECT status, count(*) FROM logistica.courier_applications a JOIN logistica.courier_application_files f ON f.application_id=a.id GROUP BY status;`)).toBe('pendiente|2');
    expect(storage.size).toBe(2);

    const list = await request(app).get('/courier-applications').set(boss.auth);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toEqual(expect.objectContaining({ id: applicationId, status: 'pendiente', applicantEmail: 'carlos@test.com', birthDate: '1995-04-20', licenseExpiresOn: '2099-01-31' }));
    const image = await request(app).get(`/courier-applications/${applicationId}/files/license`).set(boss.auth);
    expect(image.status).toBe(200);
    expect(Buffer.from(image.body as Buffer).equals(JPEG)).toBe(true);

    await sleep(1100);
    const approved = await request(app).post(`/courier-applications/${applicationId}/approve`).set(boss.auth).send({ capacity: 15 });
    expect(approved.status).toBe(200);
    expect(approved.body.application).toEqual(expect.objectContaining({ status: 'aprobada', approvedCapacity: 15 }));

    expect(runAdminSql(`SELECT u.role, c.display_name, c.max_orders_per_trip, u.tokens_valid_after IS NOT NULL FROM logistica.app_users u JOIN logistica.couriers c ON c.user_id=u.id WHERE u.id='${client.id}';`))
      .toBe('repartidor|Carlos Andrade Mora|15|t');
    expect((await request(app).get('/auth/me').set(client.auth)).status).toBe(401);
    const login = await request(app).post('/auth/login').send({ email: 'carlos@test.com', password: USER_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user).toEqual(expect.objectContaining({ role: 'repartidor', courierId: expect.any(String) }));
    expect((await request(app).get('/courier-applications/me').set(bearer(login.body.token))).status).toBe(403);
    expect(emails.sent.some((message) => message.to === 'carlos@test.com' && message.subject.includes('aprobada'))).toBe(true);
    expect((await request(app).post(`/courier-applications/${applicationId}/approve`).set(boss.auth)).body.code).toBe('NOT_PENDING');
  });

  it('rechazar guarda el motivo, deja la cuenta como cliente y permite una solicitud nueva', async () => {
    const boss = adminAuth();
    const { client, applicationId } = await submitted('carlos@test.com');
    expect((await request(app).post(`/courier-applications/${applicationId}/reject`).set(boss.auth).send({ reason: '   ' })).status).toBe(400);
    const rejected = await request(app).post(`/courier-applications/${applicationId}/reject`).set(boss.auth).send({ reason: 'La foto de la licencia no se lee.' });
    expect(rejected.status).toBe(200);
    expect(runAdminSql(`SELECT role FROM logistica.app_users WHERE id='${client.id}';`)).toBe('cliente');
    expect(runAdminSql('SELECT count(*) FROM logistica.couriers;')).toBe('0');
    expect((await request(app).get('/auth/me').set(client.auth)).status).toBe(200);
    const mine = await request(app).get('/courier-applications/me').set(client.auth);
    expect(mine.body.application).toEqual(expect.objectContaining({ status: 'rechazada', rejectionReason: 'La foto de la licencia no se lee.' }));
    const retry = await request(app).put('/courier-applications/me').set(client.auth).send(VALID_FORM);
    expect(retry.status).toBe(200);
    expect(retry.body.application.status).toBe('borrador');
  });

  it('reglas de la base: una abierta por usuario, cédula vigente única, resuelta inmutable y claves de archivo válidas', async () => {
    const { client, applicationId } = await submitted('uno@test.com');
    const other = await customer('dos@test.com');
    expect((await request(app).put('/courier-applications/me').set(client.auth).send(VALID_FORM)).body.code).toBe('ALREADY_PENDING');
    expect((await request(app).put('/courier-applications/me').set(other.auth).send(VALID_FORM)).body.code).toBe('DUPLICATE_NATIONAL_ID');

    // Con SQL directo tampoco se pueden saltar los índices parciales ni la inmutabilidad.
    const insert = (status: string, nationalId: string, user: string) =>
      `INSERT INTO logistica.courier_applications(user_id,status,full_name,national_id,phone,birth_date,vehicle_type,license_number,license_category,license_expires_on${status === 'pendiente' ? ',submitted_at' : ''}) VALUES ('${user}','${status}','Ana Perez','${nationalId}','0991234567','1990-01-01','auto','ABCD1234','B','2099-01-01'${status === 'pendiente' ? ',now()' : ''});`;
    expect(() => runAdminSql(insert('borrador', '1700000001', client.id))).toThrow();
    expect(() => runAdminSql(insert('pendiente', VALID_FORM.nationalId, other.id))).toThrow();
    expect(() => runAdminSql(`UPDATE logistica.courier_applications SET user_id='${other.id}' WHERE id='${applicationId}';`)).toThrow();
    expect(() => runAdminSql(`INSERT INTO logistica.courier_application_files(application_id,kind,content_type,size_bytes,sha256,storage_key) VALUES ('${applicationId}','otro','image/png',1,'${'a'.repeat(64)}','${'b'.repeat(32)}.png');`)).toThrow();
    expect(() => runAdminSql(`UPDATE logistica.courier_application_files SET storage_key='../../etc/passwd' WHERE application_id='${applicationId}';`)).toThrow();

    const boss = adminAuth();
    await request(app).post(`/courier-applications/${applicationId}/reject`).set(boss.auth).send({ reason: 'Documento ilegible.' });
    expect(() => runAdminSql(`UPDATE logistica.courier_applications SET phone='0990000000' WHERE id='${applicationId}';`)).toThrow();
    // Ya rechazada: la cédula queda libre para otra solicitud.
    expect((await request(app).put('/courier-applications/me').set(other.auth).send(VALID_FORM)).status).toBe(200);
  });

  it('aprobar es atómico y solo lo hace un administrador activo; si el solicitante dejó de ser cliente no cambia nada', async () => {
    const boss = adminAuth();
    const { client, applicationId } = await submitted('carlos@test.com');
    const review = (reviewer: string, approve: boolean, reason: string | null, capacity: number | null, id = applicationId) =>
      `SELECT logistica.review_courier_application('${id}'::uuid, '${reviewer}'::uuid, ${approve}, ${reason === null ? 'NULL' : `'${reason}'`}, ${capacity === null ? 'NULL::integer' : capacity});`;

    const stranger = createFixtureActor('repartidor');
    expect(runAdminSql(review(stranger.actorId, true, null, 10))).toBe('FORBIDDEN');
    expect(() => runAdminSql(review(boss.id, false, '', null))).toThrow();
    expect(() => runAdminSql(review(boss.id, true, null, 0))).toThrow();
    expect(runAdminSql(review(boss.id, true, null, 10, '11111111-1111-4111-8111-111111111111'))).toBe('NOT_FOUND');

    runAdminSql(`UPDATE logistica.app_users SET is_active=false WHERE id='${client.id}';`);
    expect(runAdminSql(review(boss.id, true, null, 10))).toBe('NOT_CLIENT');
    expect(runAdminSql('SELECT count(*) FROM logistica.couriers;')).toBe('0');
    expect(runAdminSql(`SELECT role FROM logistica.app_users WHERE id='${client.id}';`)).toBe('cliente');
    expect(runAdminSql(`SELECT status FROM logistica.courier_applications WHERE id='${applicationId}';`)).toBe('pendiente');
  });

  it('lista con filtros, orden y búsqueda segura desde la base', async () => {
    const boss = adminAuth();
    const first = await submitted('uno@test.com');
    await submitted('dos@test.com', { ...VALID_FORM, nationalId: '1723456784', fullName: 'María Torres Vega' });
    const draftOnly = await customer('tres@test.com');
    await request(app).put('/courier-applications/me').set(draftOnly.auth).send({ ...VALID_FORM, nationalId: '1711111110' });
    await request(app).post(`/courier-applications/${first.applicationId}/reject`).set(boss.auth).send({ reason: 'Documento ilegible.' });

    const all = await request(app).get('/courier-applications').set(boss.auth);
    expect(all.body.total).toBe(2);
    // Las pendientes primero.
    expect(all.body.items.map((item: { status: string }) => item.status)).toEqual(['pendiente', 'rechazada']);
    expect((await request(app).get('/courier-applications?status=rechazada').set(boss.auth)).body.total).toBe(1);
    expect((await request(app).get('/courier-applications?q=TORRES').set(boss.auth)).body.total).toBe(1);
    expect((await request(app).get('/courier-applications?q=1723456784').set(boss.auth)).body.total).toBe(1);
    expect((await request(app).get('/courier-applications?q=uno@test').set(boss.auth)).body.total).toBe(1);
    expect((await request(app).get('/courier-applications?q=%25').set(boss.auth)).body.total).toBe(0);
    expect((await request(app).get("/courier-applications?q='%3B%20DROP%20TABLE%20logistica.courier_applications%3B--").set(boss.auth)).body.total).toBe(0);
    expect((await request(app).get('/courier-applications?limit=1&offset=1').set(boss.auth)).body.items).toHaveLength(1);
    // Los borradores no se ven ni se descargan.
    const draftId = runAdminSql(`SELECT id FROM logistica.courier_applications WHERE user_id='${draftOnly.id}';`);
    expect((await request(app).get(`/courier-applications/${draftId}`).set(boss.auth)).status).toBe(404);
    expect(runAdminSql('SELECT count(*) FROM logistica.courier_applications;')).toBe('3');
  });
});

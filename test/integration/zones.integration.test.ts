import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import type { ZoneRepository } from '../../src/modules/zones/application/ports/zone.repository.port.js';
import { integrationRepositories, closeIntegrationDatabase } from './database.fixture.js';

describe('S1-CP-003 · Zonas: registro y validación integrada', () => {
  let zoneRepository: ZoneRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const repositories = integrationRepositories();
    zoneRepository = repositories.zoneRepository;
    app = createApp({
      webOrigin: 'http://localhost:5173',
      zoneRepository,
      orderRepository: repositories.orderRepository,
      orderZoneLookup: repositories.orderZoneLookup,
    });
  });

  afterAll(closeIntegrationDatabase);

  describe('Registro de zona válida', () => {
    it('debe registrar y persistir una zona válida con código 201 y metadatos correctos', async () => {
      const payload = { name: 'Centro' };

      const createResponse = await request(app)
        .post('/zones')
        .send(payload)
        .set('Content-Type', 'application/json');

      expect(createResponse.status).toBe(201);
      expect(createResponse.body).toHaveProperty('id');
      expect(typeof createResponse.body.id).toBe('string');
      expect(createResponse.body.name).toBe('Centro');
      expect(createResponse.body).toHaveProperty('createdAt');
      expect(createResponse.body).toHaveProperty('updatedAt');

      // Validar formato ISO-8601 UTC
      const createdAtDate = new Date(createResponse.body.createdAt);
      expect(createdAtDate.toISOString()).toBe(createResponse.body.createdAt);

      const zoneId = createResponse.body.id;

      // Consultar la zona por su identificador
      const getResponse = await request(app).get(`/zones/${zoneId}`);
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.id).toBe(zoneId);
      expect(getResponse.body.name).toBe('Centro');

      // Comprobar disponibilidad general de la zona
      const listResponse = await request(app).get('/zones');
      expect(listResponse.status).toBe(200);
      expect(listResponse.body).toHaveProperty('items');
      expect(listResponse.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: zoneId,
            name: 'Centro',
          }),
        ])
      );
    });
  });

  describe('Validación de entradas inválidas', () => {
    it('debe rechazar un nombre de zona vacío con código 400 y VALIDATION_ERROR', async () => {
      const response = await request(app)
        .post('/zones')
        .send({ name: '' })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');

      // Verificar que no se persistió ninguna zona
      const listResponse = await request(app).get('/zones');
      expect(listResponse.body.items).toHaveLength(0);
    });

    it('debe rechazar un nombre de zona compuesto únicamente por espacios en blanco', async () => {
      const response = await request(app)
        .post('/zones')
        .send({ name: '     ' })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');

      const listResponse = await request(app).get('/zones');
      expect(listResponse.body.items).toHaveLength(0);
    });

    it('debe rechazar un payload sin el campo name con código 400 y VALIDATION_ERROR', async () => {
      const response = await request(app)
        .post('/zones')
        .send({})
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('debe rechazar un campo name que no sea texto con código 400 y VALIDATION_ERROR', async () => {
      const response = await request(app)
        .post('/zones')
        .send({ name: 12345 })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it.each([
      ['demasiado corto', 'ab'],
      ['demasiado largo', 'Z'.repeat(41)],
      ['con menos de 3 letras', '1 2 a b'],
    ])('rechaza un nombre %s con 400 y no crea la zona', async (_motivo, name) => {
      const response = await request(app).post('/zones').send({ name });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect((await request(app).get('/zones')).body.items).toHaveLength(0);
    });

    it('acepta un nombre de entre 3 y 40 caracteres y lo guarda recortado', async () => {
      const response = await request(app).post('/zones').send({ name: '  Ambato Centro  ' });
      expect(response.status).toBe(201);
      expect(response.body.name).toBe('Ambato Centro');
    });
  });

  describe('Conflictos y casos de consulta', () => {
    it('debe rechazar el registro de una zona con nombre duplicado con código 409 y DATA_CONFLICT', async () => {
      // Variantes de mayúsculas y espacios también cuentan como el mismo nombre.
      await request(app).post('/zones').send({ name: 'Zona Duplicable' });
      for (const variant of ['zona duplicable', '  ZONA DUPLICABLE  ']) {
        const repeated = await request(app).post('/zones').send({ name: variant });
        expect(repeated.status).toBe(409);
        expect(repeated.body.code).toBe('DATA_CONFLICT');
      }

      await request(app).post('/zones').send({ name: 'Norte' });

      const duplicateResponse = await request(app)
        .post('/zones')
        .send({ name: 'Norte' });

      expect(duplicateResponse.status).toBe(409);
      expect(duplicateResponse.body.code).toBe('DATA_CONFLICT');
    });

    it('debe responder 404 y ZONE_NOT_FOUND cuando se consulta una zona inexistente', async () => {
      const nonExistentUuid = 'a0000000-0000-4000-8000-000000000000';
      const response = await request(app).get(`/zones/${nonExistentUuid}`);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('ZONE_NOT_FOUND');
    });

    it('debe responder 400 y VALIDATION_ERROR cuando se consulta con un identificador que no es UUID', async () => {
      const response = await request(app).get('/zones/not-a-valid-uuid');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Activar y desactivar zonas (migración 019)', () => {
    const create = async (name: string): Promise<string> => {
      const response = await request(app).post('/zones').send({ name });
      expect(response.status).toBe(201);
      expect(response.body.isActive).toBe(true);
      return response.body.id as string;
    };
    const setActive = (id: string, body: unknown) => request(app).patch(`/zones/${id}`).send(body as object);
    const lookup = (latitude: number, longitude: number) =>
      request(app).get('/zones/lookup').query({ latitude: String(latitude), longitude: String(longitude) });

    it('desactiva y reactiva una zona sin trabajo; la lista y el detalle reflejan el estado', async () => {
      const id = await create('Zona Estado A');
      const off = await setActive(id, { isActive: false });
      expect(off.status).toBe(200);
      expect(off.body.isActive).toBe(false);
      expect((await request(app).get(`/zones/${id}`)).body.isActive).toBe(false);
      const listed = (await request(app).get('/zones')).body.items as Array<{ id: string; isActive: boolean }>;
      expect(listed.find((zone) => zone.id === id)?.isActive).toBe(false);

      expect((await setActive(id, { isActive: false })).status).toBe(200); // idempotente
      const on = await setActive(id, { isActive: true });
      expect(on.status).toBe(200);
      expect(on.body.isActive).toBe(true);
    });

    it('una zona inactiva deja de atender puntos del mapa y conserva su cobertura al reactivarse', async () => {
      const id = await create('Zona Estado B');
      const coverage = { latitude: -1.2491, longitude: -78.6167, radiusKm: 4 };
      expect((await request(app).put(`/zones/${id}/coverage`).send({ coverage })).status).toBe(200);
      expect((await lookup(-1.2491, -78.6167)).body.zone).toMatchObject({ id });

      await setActive(id, { isActive: false });
      expect((await lookup(-1.2491, -78.6167)).body.zone).toBeNull();

      const back = await setActive(id, { isActive: true });
      expect(back.body.coverage).toEqual(coverage);
      expect((await lookup(-1.2491, -78.6167)).body.zone).toMatchObject({ id });
    });

    it('no se puede desactivar con un pedido sin cerrar (409 ZONE_IN_USE) y no recibe pedidos nuevos al desactivarse', async () => {
      const id = await create('Zona Estado C');
      await request(app).put(`/zones/${id}/coverage`).send({ coverage: { latitude: -1.2491, longitude: -78.6167, radiusKm: 4 } });
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(Date.now() + 2 * 86_400_000));
      const order = await request(app).post('/orders').set('Idempotency-Key', '6f1f8f0e-3c1a-4c55-9b53-6d3a2f9a1c01')
        .send({ zoneId: id, deliveryAddress: 'Av. Cevallos y Montalvo', deliveryDate: date, deliveryTime: '10:00' });
      expect(order.status).toBe(201);

      const blocked = await setActive(id, { isActive: false });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('ZONE_IN_USE');
      expect((await request(app).get(`/zones/${id}`)).body.isActive).toBe(true);
    });

    it('valida el cuerpo, el identificador y la existencia', async () => {
      const id = await create('Zona Estado D');
      expect((await setActive(id, {})).status).toBe(400);
      expect((await setActive(id, { isActive: 'no' })).status).toBe(400);
      expect((await setActive(id, { isActive: null })).status).toBe(400);
      expect((await setActive(id, { isActive: false, name: 'x' })).status).toBe(400);
      expect((await setActive('no-es-uuid', { isActive: false })).status).toBe(400);
      expect((await setActive('3f2b8c1e-9a4d-4c2b-8e1f-123456789abc', { isActive: false })).status).toBe(404);
    });
  });

  describe('Cobertura de la zona y zona de un punto del mapa (migración 015)', () => {
    const create = async (name: string): Promise<string> => {
      const response = await request(app).post('/zones').send({ name });
      expect(response.status).toBe(201);
      expect(response.body.coverage).toBeNull();
      return response.body.id as string;
    };
    const cover = (id: string, coverage: unknown) => request(app).put(`/zones/${id}/coverage`).send({ coverage });
    const lookup = (latitude: unknown, longitude: unknown) =>
      request(app).get('/zones/lookup').query({ latitude: String(latitude), longitude: String(longitude) });

    it('fija el centro y el radio, y un punto cae en la zona de centro más cercano que lo cubre', async () => {
      const centro = await create('Cobertura Centro');
      const izamba = await create('Cobertura Izamba');

      const saved = await cover(centro, { latitude: -1.242, longitude: -78.628, radiusKm: 3 });
      expect(saved.status).toBe(200);
      expect(saved.body.coverage).toEqual({ latitude: -1.242, longitude: -78.628, radiusKm: 3 });
      expect((await cover(izamba, { latitude: -1.21, longitude: -78.599, radiusKm: 3 })).status).toBe(200);

      const inCentro = await lookup(-1.243, -78.627);
      expect(inCentro.status).toBe(200);
      expect(inCentro.body.zone).toMatchObject({ id: centro, name: 'Cobertura Centro' });
      expect((await lookup(-1.211, -78.6)).body.zone).toMatchObject({ id: izamba });

      const outside = await lookup(-0.1807, -78.4678);
      expect(outside.status).toBe(200);
      expect(outside.body.zone).toBeNull();

      const listed = await request(app).get('/zones');
      const found = (listed.body.items as Array<{ id: string; coverage: unknown }>).find((zone) => zone.id === centro);
      expect(found?.coverage).toEqual({ latitude: -1.242, longitude: -78.628, radiusKm: 3 });
    });

    it('quitar la cobertura deja de detectar la zona', async () => {
      const id = await create('Cobertura Temporal');
      expect((await cover(id, { latitude: -1.242, longitude: -78.628, radiusKm: 2 })).status).toBe(200);
      expect((await lookup(-1.242, -78.628)).body.zone).toMatchObject({ id });
      const removed = await cover(id, null);
      expect(removed.status).toBe(200);
      expect(removed.body.coverage).toBeNull();
      expect((await lookup(-1.242, -78.628)).body.zone).toBeNull();
    });

    it('valida la cobertura, el punto y la zona', async () => {
      const id = await create('Cobertura Validaciones');
      expect((await cover(id, { latitude: -1.2, longitude: -78.6, radiusKm: 0 })).status).toBe(400);
      expect((await cover(id, { latitude: -1.2, longitude: -78.6, radiusKm: 51 })).status).toBe(400);
      expect((await cover(id, { latitude: 40.4, longitude: -3.7, radiusKm: 2 })).status).toBe(400);
      expect((await cover(id, { latitude: '-1.2', longitude: -78.6, radiusKm: 2 })).status).toBe(400);
      expect((await cover(id, { latitude: -1.2, longitude: -78.6, radiusKm: 2, extra: 1 })).status).toBe(400);
      expect((await request(app).put(`/zones/${id}/coverage`).send({})).status).toBe(400);
      expect((await cover('a0000000-0000-4000-8000-000000000000', { latitude: -1.2, longitude: -78.6, radiusKm: 2 })).status).toBe(404);
      expect((await cover('no-es-uuid', null)).status).toBe(400);
      expect((await lookup('abc', -78.6)).status).toBe(400);
      expect((await lookup(40.4, -3.7)).status).toBe(400);
      expect((await request(app).get('/zones/lookup')).status).toBe(400);
    });
  });
});

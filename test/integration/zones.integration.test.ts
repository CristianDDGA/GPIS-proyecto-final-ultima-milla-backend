import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import type { ZoneRepository } from '../../src/modules/zones/application/ports/zone.repository.port.js';
import { integrationRepositories, closeIntegrationDatabase } from './database.fixture.js';

describe('S1-CP-003 · Zonas: registro y validación integrada', () => {
  let zoneRepository: ZoneRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    zoneRepository = integrationRepositories().zoneRepository;
    app = createApp({
      webOrigin: 'http://localhost:5173',
      zoneRepository,
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
  });

  describe('Conflictos y casos de consulta', () => {
    it('debe rechazar el registro de una zona con nombre duplicado con código 409 y DATA_CONFLICT', async () => {
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

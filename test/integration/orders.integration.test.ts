import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import type { ZoneRepository } from '../../src/modules/zones/application/ports/zone.repository.port.js';
import type { OrderRepository } from '../../src/modules/orders/application/ports/order.repository.port.js';
import { integrationRepositories, closeIntegrationDatabase, realDatabase, loadRepresentativeFixture, setTestZoneInactive } from './database.fixture.js';
import { Zone } from '../../src/modules/zones/domain/zone.entity.js';

describe('Suite de Integración API / Persistencia - Pedidos', () => {
  let zoneRepository: ZoneRepository;
  let orderRepository: OrderRepository;
  let app: ReturnType<typeof createApp>;
  let validZone: Zone;

  beforeEach(async () => {
    const repositories = integrationRepositories();
    zoneRepository = repositories.zoneRepository;
    orderRepository = repositories.orderRepository;

    app = createApp({
      webOrigin: 'http://localhost:5173',
      zoneRepository,
      orderRepository,
      orderZoneLookup: repositories.orderZoneLookup,
    });

    // Zona válida base para las pruebas de pedidos
    validZone = await zoneRepository.create(Zone.prepare({ name: 'Centro' }));
  });

  afterAll(closeIntegrationDatabase);

  describe('S1-CP-005 · Pedidos: registro y validación integrada', () => {
    it('debe registrar y recuperar un pedido válido con código 201, estado pendiente y datos íntegros', async () => {
      const orderPayload = {
        zoneId: validZone.id,
        deliveryAddress: 'Av. 9 de Octubre 123 y Malecón',
        deliveryDate: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(Date.now() + 2 * 86_400_000)),
        deliveryTime: '14:30',
      };

      const createResponse = await request(app)
        .post('/orders')
        .send(orderPayload)
        .set('Content-Type', 'application/json');

      expect(createResponse.status).toBe(201);
      expect(createResponse.body).toHaveProperty('id');
      expect(createResponse.body.zoneId).toBe(validZone.id);
      expect(createResponse.body.deliveryAddress).toBe('Av. 9 de Octubre 123 y Malecón');
      expect(createResponse.body.deliveryDate).toBe(orderPayload.deliveryDate);
      expect(createResponse.body.deliveryTime).toBe('14:30');
      expect(createResponse.body.status).toBe('pendiente');
      expect(createResponse.body).toHaveProperty('createdAt');
      expect(createResponse.body).toHaveProperty('updatedAt');

      const orderId = createResponse.body.id;

      // Recuperar el pedido por API (GetOrder)
      const getResponse = await request(app).get(`/orders/${orderId}`);
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.id).toBe(orderId);
      expect(getResponse.body.zoneId).toBe(validZone.id);
      expect(getResponse.body.status).toBe('pendiente');
    });

    describe('Variantes inválidas rechazadas con 400 y VALIDATION_ERROR', () => {
      it.each(['zoneId', 'deliveryAddress', 'deliveryDate', 'deliveryTime'])('rechaza el campo ausente %s sin persistir', async (field) => {
        const payload: Record<string, unknown> = {zoneId:validZone.id,deliveryAddress:'Dirección',deliveryDate:'2026-10-20',deliveryTime:'10:00'};
        delete payload[field];
        const result = await request(app).post('/orders').send(payload);
        expect(result.status).toBe(400);
        expect(result.body.code).toBe('VALIDATION_ERROR');
        expect((await request(app).get('/orders')).body.items).toHaveLength(0);
      });

      it.each(['null', '[]', '{'])('rechaza cuerpo JSON inválido %s sin persistir', async (body) => {
        const result = await request(app).post('/orders').set('Content-Type','application/json').send(body);
        expect(result.status).toBe(400);
        expect(result.body.code).toBe('VALIDATION_ERROR');
        expect((await request(app).get('/orders')).body.items).toHaveLength(0);
      });

      it('debe rechazar cuando la dirección de entrega está vacía', async () => {
        const response = await request(app)
          .post('/orders')
          .send({
            zoneId: validZone.id,
            deliveryAddress: '   ',
            deliveryDate: '2026-10-20',
            deliveryTime: '14:30',
          });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');

        // Comprobar rechazo sin persistencia
        const listResponse = await request(app).get('/orders');
        expect(listResponse.body.items).toHaveLength(0);
      });

      it.each([
        ['la fecha de entrega tiene formato inválido', '20-10-2026', '14:30'],
        ['la fecha de entrega no existe en el calendario', '2026-02-31', '14:30'],
        ['la hora de entrega tiene formato inválido', '2026-10-20', '25:99'],
      ])('debe rechazar cuando %s', async (_description, deliveryDate, deliveryTime) => {
        const response = await request(app)
          .post('/orders')
          .send({
            zoneId: validZone.id,
            deliveryAddress: 'Calle Falsa 123',
            deliveryDate,
            deliveryTime,
          });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      });

      it('debe rechazar cuando el zoneId no es un UUID válido', async () => {
        const response = await request(app)
          .post('/orders')
          .send({
            zoneId: 'no-es-uuid',
            deliveryAddress: 'Calle Falsa 123',
            deliveryDate: '2026-10-20',
            deliveryTime: '14:30',
          });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('Zona inexistente rechazada con 404 y ZONE_NOT_FOUND', () => {
      it('debe rechazar con 404 cuando la zona no existe en la persistencia', async () => {
        const nonExistentZoneId = 'b0000000-0000-4000-8000-000000000000';

        const response = await request(app)
          .post('/orders')
          .send({
            zoneId: nonExistentZoneId,
            deliveryAddress: 'Av. Las Lomas 456',
            deliveryDate: '2026-10-20',
            deliveryTime: '10:00',
          });

        expect(response.status).toBe(404);
        expect(response.body.code).toBe('ZONE_NOT_FOUND');

        // Verificar que no se guardó el pedido
        const listResponse = await request(app).get('/orders');
        expect(listResponse.body.items).toHaveLength(0);
      });
    });
  });

  describe('S1-CP-010 · Recepción de pedidos para hoy', () => {
    (realDatabase ? it : it.skip)('rechaza una entrega pasada con VALIDATION_ERROR sin insertar', async () => {
      const yesterday = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guayaquil',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-86_400_000));
      const result = await request(app).post('/orders').send({zoneId:validZone.id,deliveryAddress:'Dirección',deliveryDate:yesterday,deliveryTime:'10:00'});
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('VALIDATION_ERROR');
      expect((await request(app).get('/orders')).body.items).toHaveLength(0);
    });

    (realDatabase ? it : it.skip)('rechaza una zona inactiva sin insertar', async () => {
      setTestZoneInactive(validZone.id);
      const result = await request(app).post('/orders').send({zoneId:validZone.id,deliveryAddress:'Dirección',deliveryDate:'2026-10-20',deliveryTime:'10:00'});
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('DATA_CONFLICT');
      expect((await request(app).get('/orders')).body.items).toHaveLength(0);
    });

    it('debe registrar y persistir un pedido con entrega para el día de hoy (America/Guayaquil)', async () => {
      // Obtener el día actual de negocio en la zona horaria America/Guayaquil
      const todayInGuayaquil = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Guayaquil',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      const orderPayload = {
        zoneId: validZone.id,
        deliveryAddress: 'Av. Francisco de Orellana 500',
        deliveryDate: todayInGuayaquil,
        deliveryTime: '16:00',
      };

      const createResponse = await request(app)
        .post('/orders')
        .send(orderPayload);

      expect(createResponse.status).toBe(201);
      expect(createResponse.body.deliveryDate).toBe(todayInGuayaquil);
      expect(createResponse.body.status).toBe('pendiente');

      const orderId = createResponse.body.id;
      const getResponse = await request(app).get(`/orders/${orderId}`);
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.deliveryDate).toBe(todayInGuayaquil);
    });
  });

  describe('S1-CP-009 · Recuperación y filtros de pedidos con Fixture representativa', () => {
    it('conserva creación y entrega por separado e ignora metadatos del cliente', async () => {
      const futureDate = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guayaquil',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+2*86_400_000));
      const before = Date.now();
      const result = await request(app).post('/orders').send({zoneId:validZone.id,deliveryAddress:"Dirección '; DROP TABLE logistica.orders; --",deliveryDate:futureDate,deliveryTime:'14:30',status:'entregado',createdAt:'1990-01-01T00:00:00.000Z',id:'b0000000-0000-4000-8000-000000000000'});
      expect(result.status).toBe(201);
      expect(result.body.status).toBe('pendiente');
      expect(new Date(result.body.createdAt).getTime()).toBeGreaterThanOrEqual(before-1000);
      expect(new Date(result.body.createdAt).getTime()).toBeLessThanOrEqual(Date.now()+1000);
      expect(result.body.deliveryDate).toBe(futureDate);
      expect(result.body.deliveryTime).toBe('14:30');
      expect(result.body.id).not.toBe('b0000000-0000-4000-8000-000000000000');
      const recovered = await request(app).get(`/orders/${result.body.id}`);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual(result.body);
      expect((await request(app).get('/orders')).body.items).toHaveLength(1);
    });

    it.each(['deliveryDate=2026-02-31','deliveryDate=','zoneId=invalido','deliveryDate=2026-10-20&deliveryDate=2026-10-26'])('rechaza filtro mal formado %s', async (query) => {
      const result = await request(app).get(`/orders?${query}`);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('VALIDATION_ERROR');
    });

    it('debe cumplir con los resultados esperados de la fixture: 12 sin filtro, 6 por fecha, 4 por zona, 2 por fecha+zona y 0 sin coincidencia', async () => {
      if (realDatabase) {
        loadRepresentativeFixture();
        const centro = await zoneRepository.findById('10000000-0000-4000-8000-000000000001');
        if (!centro) throw new Error('Falta Centro en la semilla original.');
        validZone = centro;
      } else {
        // 1. Crear las 3 zonas de la fixture: Centro (ya creada), Norte y Sur
        const zoneNorte = await zoneRepository.create(Zone.prepare({ name: 'Norte' }));
        const zoneSur = await zoneRepository.create(Zone.prepare({ name: 'Sur' }));

        const zones = [validZone, zoneNorte, zoneSur];
        const dates = ['2026-10-20', '2026-10-26'];

        // 2. Insertar 12 pedidos: 2 por cada combinación de zona y fecha
        for (const zone of zones) {
          for (const date of dates) {
            for (let i = 1; i <= 2; i++) {
              await request(app)
                .post('/orders')
                .send({
                  zoneId: zone.id,
                  deliveryAddress: `Dirección ${zone.name} ${date} #${i}`,
                  deliveryDate: date,
                  deliveryTime: `10:0${i}`,
                });
            }
          }
        }

      // Verificación 1: 12 sin filtros
      }
      const resTotal = await request(app).get('/orders');
      expect(resTotal.status).toBe(200);
      expect(resTotal.body.items).toHaveLength(12);

      // Verificación 2: 6 por fecha (2026-10-20)
      const resFecha = await request(app).get('/orders?deliveryDate=2026-10-20');
      expect(resFecha.status).toBe(200);
      expect(resFecha.body.items).toHaveLength(6);

      // Verificación 3: 4 por zona (Centro)
      const resZona = await request(app).get(`/orders?zoneId=${validZone.id}`);
      expect(resZona.status).toBe(200);
      expect(resZona.body.items).toHaveLength(4);

      // Verificación 4: 2 por fecha + zona (Centro AND 2026-10-20)
      const resFechaYZona = await request(app).get(
        `/orders?deliveryDate=2026-10-20&zoneId=${validZone.id}`
      );
      expect(resFechaYZona.status).toBe(200);
      expect(resFechaYZona.body.items).toHaveLength(2);
      expect(resFechaYZona.body.items.every((item: {zoneId:string;deliveryDate:string}) => item.zoneId===validZone.id && item.deliveryDate==='2026-10-20')).toBe(true);

      // Verificación 5: 0 sin coincidencias
      const resSinCoincidencia = await request(app).get('/orders?deliveryDate=2026-10-01');
      expect(resSinCoincidencia.status).toBe(200);
      expect(resSinCoincidencia.body.items).toHaveLength(0);
    });
  });
});

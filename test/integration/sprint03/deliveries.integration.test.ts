import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createDatabaseClient } from '../../../src/bootstrap/database.js';
import { createDeliveriesApp } from '../../../src/bootstrap/sprint03/deliveries.server.js';
import { StaticActorContext } from '../../../src/modules/deliveries/infrastructure/context/static-actor.context.js';
import { PrismaDeliveryRepository } from '../../../src/modules/deliveries/infrastructure/postgres/prisma-delivery.repository.js';
import {
  createFixtureActor,
  createLinkedCourier,
  deliveryDatabase,
  disableCourier,
  prepareAssignedRoute,
  preparePlannedRoute,
  prepareUnassignedOrder,
  readOrderAuditSnapshot,
  readRouteAuditSnapshot,
  resetTestData,
  setActorActive,
  type FixtureDatabase,
} from './deliveries.fixture.js';

const describeReal = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;

describeReal('Sprint 03 - Deliveries - PostgreSQL real (sin mocks)', () => {
  let database: FixtureDatabase;
  let secondDatabase: FixtureDatabase;

  function buildApp(db: FixtureDatabase, actorId: string | null) {
    return createDeliveriesApp({
      repository: new PrismaDeliveryRepository(db),
      actorContext: new StaticActorContext(actorId),
      webOrigin: 'http://localhost:5173',
    });
  }

  beforeAll(() => {
    database = deliveryDatabase();
    secondDatabase = deliveryDatabase();
  });

  beforeEach(() => {
    resetTestData();
  });

  afterAll(async () => {
    await database?.$disconnect();
    await secondDatabase?.$disconnect();
  });

  describe('S3-CP-003 - consulta, estados idempotentes, concurrencia y cierre de ruta', () => {
    it('consulta pedido existente, pendiente sin ruta y errores de consulta', async () => {
      const courierUser = createFixtureActor('repartidor', true);
      const assigned = await prepareAssignedRoute(database, {
        courierUserId: courierUser.actorId,
      });
      const pending = await prepareUnassignedOrder(database);
      const app = buildApp(database, courierUser.actorId);

      const detail = await request(app).get(
        `/delivery-orders/${assigned.orderIds[0]}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body).toEqual({
        orderId: assigned.orderIds[0],
        routeId: assigned.routeId,
        status: 'asignado_a_ruta',
        version: '2',
        deliveredAt: null,
        updatedAt: expect.stringMatching(/Z$/),
      });
      expect(typeof detail.body.version).toBe('string');

      const pendingDetail = await request(app).get(
        `/delivery-orders/${pending.orderId}`,
      );
      expect(pendingDetail.status).toBe(200);
      expect(pendingDetail.body).toEqual({
        orderId: pending.orderId,
        routeId: null,
        status: 'pendiente',
        version: '1',
        deliveredAt: null,
        updatedAt: expect.stringMatching(/Z$/),
      });

      const missing = await request(app).get(`/delivery-orders/${randomUUID()}`);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('ORDER_NOT_FOUND');

      const invalid = await request(app).get('/delivery-orders/no-uuid');
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('VALIDATION_ERROR');
    });

    it('avanza recogido -> en_camino -> entregado con historial/outbox atómicos, replay idempotente y cierre', async () => {
      const courierUser = createFixtureActor('repartidor', true);
      const staffUser = createFixtureActor('personal', true);
      const assigned = await prepareAssignedRoute(database, {
        courierUserId: courierUser.actorId,
        orderCount: 2,
      });
      const courierApp = buildApp(database, courierUser.actorId);
      const staffApp = buildApp(database, staffUser.actorId);
      const firstOrderId = assigned.orderIds[0]!;
      const secondOrderId = assigned.orderIds[1]!;

      const initial = await request(courierApp).get(
        `/delivery-orders/${firstOrderId}`,
      );
      expect(initial.status).toBe(200);
      expect(initial.body.version).toBe('2');

      const keyPickup = randomUUID();
      const pickup = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', keyPickup)
        .send({
          orderId: firstOrderId,
          newStatus: 'recogido',
          expectedVersion: initial.body.version,
        });
      expect(pickup.status).toBe(200);
      expect(pickup.body).toEqual({
        orderId: firstOrderId,
        status: 'recogido',
        version: '3',
      });

      const afterPickup = await readOrderAuditSnapshot(database, firstOrderId);
      expect(afterPickup.orderStatus).toBe('recogido');
      expect(afterPickup.orderVersion).toBe('3');
      expect(afterPickup.routeStatus).toBe('asignada');
      expect(afterPickup.orderEvents.at(-1)).toEqual({
        orderVersion: '3',
        fromStatus: 'asignado_a_ruta',
        toStatus: 'recogido',
        actorSubject: courierUser.authSubject,
        source: 'mobile',
      });
      expect(afterPickup.outboxEvents).toHaveLength(3);
      expect(afterPickup.outboxEvents.at(-1)).toEqual({
        aggregateVersion: '3',
        eventType: 'pedido.estado_cambiado',
        payloadStatus: 'recogido',
      });

      // Replay with same Idempotency-Key and original payload repeats 200 without new event.
      const replay = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', keyPickup)
        .send({
          orderId: firstOrderId,
          newStatus: 'recogido',
          expectedVersion: '2',
        });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(pickup.body);
      const afterReplay = await readOrderAuditSnapshot(database, firstOrderId);
      expect(afterReplay.orderEvents).toHaveLength(afterPickup.orderEvents.length);
      expect(afterReplay.outboxEvents).toHaveLength(afterPickup.outboxEvents.length);

      // Same Idempotency-Key with conflicting payload returns 409 without side effects.
      const conflictingReplay = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', keyPickup)
        .send({
          orderId: firstOrderId,
          newStatus: 'en_camino',
          expectedVersion: '3',
        });
      expect(conflictingReplay.status).toBe(409);
      expect(conflictingReplay.body.code).toBe('DATA_CONFLICT');

      // Advance first order to en_camino (route moves to en_curso) and entregado.
      const inTransit = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({
          orderId: firstOrderId,
          newStatus: 'en_camino',
          expectedVersion: '3',
        });
      expect(inTransit.status).toBe(200);
      expect(inTransit.body).toEqual({
        orderId: firstOrderId,
        status: 'en_camino',
        version: '4',
      });

      const afterTransit = await readOrderAuditSnapshot(database, firstOrderId);
      expect(afterTransit.routeStatus).toBe('en_curso');

      const deliveredKey = randomUUID();
      const delivered = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', deliveredKey)
        .send({
          orderId: firstOrderId,
          newStatus: 'entregado',
          expectedVersion: '4',
        });
      expect(delivered.status).toBe(200);
      expect(delivered.body).toEqual({
        orderId: firstOrderId,
        status: 'entregado',
        version: '5',
      });

      const deliveredDetail = await request(courierApp).get(
        `/delivery-orders/${firstOrderId}`,
      );
      expect(deliveredDetail.status).toBe(200);
      expect(deliveredDetail.body).toEqual({
        orderId: firstOrderId,
        routeId: assigned.routeId,
        status: 'entregado',
        version: '5',
        deliveredAt: expect.stringMatching(/Z$/),
        updatedAt: expect.stringMatching(/Z$/),
      });

      // Route cannot complete while second order is not delivered yet.
      const prematureClose = await request(courierApp)
        .post('/route-completions')
        .send({ routeId: assigned.routeId });
      expect(prematureClose.status).toBe(409);
      expect(prematureClose.body.code).toBe('DATA_CONFLICT');

      // Staff user ("personal") advances the second order according to server policy.
      for (const [status, expectedVersion] of [
        ['recogido', '2'],
        ['en_camino', '3'],
        ['entregado', '4'],
      ] as const) {
        const step = await request(staffApp)
          .post('/delivery-status-changes')
          .set('Idempotency-Key', randomUUID())
          .send({ orderId: secondOrderId, newStatus: status, expectedVersion });
        expect(step.status).toBe(200);
      }

      const secondAudit = await readOrderAuditSnapshot(database, secondOrderId);
      expect(secondAudit.orderEvents.at(-1)).toEqual({
        orderVersion: '5',
        fromStatus: 'en_camino',
        toStatus: 'entregado',
        actorSubject: staffUser.authSubject,
        source: 'web',
      });

      const completion = await request(courierApp)
        .post('/route-completions')
        .send({ routeId: assigned.routeId });
      expect(completion.status).toBe(200);
      expect(completion.body).toEqual({
        routeId: assigned.routeId,
        status: 'completada',
      });

      const routeAudit = await readRouteAuditSnapshot(database, assigned.routeId);
      expect(routeAudit.routeStatus).toBe('completada');
      expect(routeAudit.completedAt).toMatch(/Z$/);
      expect(routeAudit.activeStopCount).toBe(0);
      expect(routeAudit.routeEvents.at(-1)).toEqual({
        routeVersion: routeAudit.routeVersion,
        fromStatus: 'en_curso',
        toStatus: 'completada',
        actorSubject: courierUser.authSubject,
      });
      expect(routeAudit.outboxEvents.at(-1)).toEqual({
        aggregateVersion: routeAudit.routeVersion,
        eventType: 'ruta.estado_cambiado',
        payloadStatus: 'completada',
      });

      // Replaying an idempotent status change even after route completion stays 200 without duplicating events.
      const postCloseReplay = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', deliveredKey)
        .send({
          orderId: firstOrderId,
          newStatus: 'entregado',
          expectedVersion: '4',
        });
      expect(postCloseReplay.status).toBe(200);
      expect(postCloseReplay.body).toEqual(delivered.body);

      const repeatClose = await request(courierApp)
        .post('/route-completions')
        .send({ routeId: assigned.routeId });
      expect(repeatClose.status).toBe(409);
      expect(repeatClose.body.code).toBe('DATA_CONFLICT');
    });

    it('rechaza saltos, retrocesos, versión antigua, ruta no iniciada y pedidos pendientes', async () => {
      const courierUser = createFixtureActor('repartidor', true);
      const staffUser = createFixtureActor('personal', true);
      const assigned = await prepareAssignedRoute(database, {
        courierUserId: courierUser.actorId,
      });
      const planned = await preparePlannedRoute(database, 1);
      const pending = await prepareUnassignedOrder(database);
      const courierApp = buildApp(database, courierUser.actorId);
      const staffApp = buildApp(database, staffUser.actorId);
      const orderId = assigned.orderIds[0]!;

      // Jump asignado_a_ruta -> en_camino or entregado rejected as 409.
      for (const jumpStatus of ['en_camino', 'entregado'] as const) {
        const before = await readOrderAuditSnapshot(database, orderId);
        const res = await request(courierApp)
          .post('/delivery-status-changes')
          .set('Idempotency-Key', randomUUID())
          .send({ orderId, newStatus: jumpStatus, expectedVersion: '2' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('DATA_CONFLICT');
        expect(await readOrderAuditSnapshot(database, orderId)).toEqual(before);
      }

      // Advance to recogido (v3) and test stale version, backward/same transition and skip to entregado.
      expect(
        (
          await request(courierApp)
            .post('/delivery-status-changes')
            .set('Idempotency-Key', randomUUID())
            .send({ orderId, newStatus: 'recogido', expectedVersion: '2' })
        ).status,
      ).toBe(200);

      const staleRes = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({ orderId, newStatus: 'en_camino', expectedVersion: '2' });
      expect(staleRes.status).toBe(409);
      expect(staleRes.body.code).toBe('DATA_CONFLICT');

      const sameRes = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({ orderId, newStatus: 'recogido', expectedVersion: '3' });
      expect(sameRes.status).toBe(409);
      expect(sameRes.body.code).toBe('DATA_CONFLICT');

      const jumpDelivered = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({ orderId, newStatus: 'entregado', expectedVersion: '3' });
      expect(jumpDelivered.status).toBe(409);
      expect(jumpDelivered.body.code).toBe('DATA_CONFLICT');

      // Advance to en_camino (v4) and test backward to recogido.
      expect(
        (
          await request(courierApp)
            .post('/delivery-status-changes')
            .set('Idempotency-Key', randomUUID())
            .send({ orderId, newStatus: 'en_camino', expectedVersion: '3' })
        ).status,
      ).toBe(200);

      const backward = await request(courierApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({ orderId, newStatus: 'recogido', expectedVersion: '4' });
      expect(backward.status).toBe(409);
      expect(backward.body.code).toBe('DATA_CONFLICT');

      // Staff cannot transition unassigned pending order or complete non-en_curso routes.
      const pendingStatus = await request(staffApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({
          orderId: pending.orderId,
          newStatus: 'recogido',
          expectedVersion: '1',
        });
      expect(pendingStatus.status).toBe(409);
      expect(pendingStatus.body.code).toBe('DATA_CONFLICT');

      const closeAssigned = await request(staffApp)
        .post('/route-completions')
        .send({ routeId: assigned.routeId });
      expect(closeAssigned.status).toBe(409);
      expect(closeAssigned.body.code).toBe('DATA_CONFLICT');

      const closePlanned = await request(staffApp)
        .post('/route-completions')
        .send({ routeId: planned.routeId });
      expect(closePlanned.status).toBe(409);
      expect(closePlanned.body.code).toBe('DATA_CONFLICT');
    });

    it('rechaza actor ajeno, inactivo, ausente, repartidor deshabilitado e ignora autoridad en body', async () => {
      const ownerUser = createFixtureActor('repartidor', true);
      const foreignUser = createFixtureActor('repartidor', true);
      const inactiveUser = createFixtureActor('repartidor', false);
      const assigned = await prepareAssignedRoute(database, {
        courierUserId: ownerUser.actorId,
      });
      const orderId = assigned.orderIds[0]!;

      const ownerApp = buildApp(database, ownerUser.actorId);
      const foreignApp = buildApp(database, foreignUser.actorId);
      const inactiveApp = buildApp(database, inactiveUser.actorId);
      const noActorApp = buildApp(database, null);

      // Even if body injects ownerUser.actorId and role:'personal', foreignApp must receive 403.
      const spoofedStatus = await request(foreignApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({
          orderId,
          newStatus: 'recogido',
          expectedVersion: '2',
          actorId: ownerUser.actorId,
          role: 'personal',
        });
      expect(spoofedStatus.status).toBe(403);
      expect(spoofedStatus.body.code).toBe('FORBIDDEN');

      const spoofedCompletion = await request(foreignApp)
        .post('/route-completions')
        .send({
          routeId: assigned.routeId,
          actorId: ownerUser.actorId,
          role: 'personal',
        });
      expect(spoofedCompletion.status).toBe(403);
      expect(spoofedCompletion.body.code).toBe('FORBIDDEN');

      expect(
        (
          await request(inactiveApp)
            .post('/delivery-status-changes')
            .set('Idempotency-Key', randomUUID())
            .send({ orderId, newStatus: 'recogido', expectedVersion: '2' })
        ).status,
      ).toBe(403);

      expect(
        (
          await request(noActorApp)
            .post('/route-completions')
            .send({ routeId: assigned.routeId })
        ).status,
      ).toBe(403);

      // Deactivating previously active ownerUser blocks subsequent transitions.
      expect(
        (
          await request(ownerApp)
            .post('/delivery-status-changes')
            .set('Idempotency-Key', randomUUID())
            .send({ orderId, newStatus: 'recogido', expectedVersion: '2' })
        ).status,
      ).toBe(200);

      setActorActive(ownerUser.actorId, false);
      const afterDeactivate = await request(ownerApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({ orderId, newStatus: 'en_camino', expectedVersion: '3' });
      expect(afterDeactivate.status).toBe(403);
      expect(afterDeactivate.body.code).toBe('FORBIDDEN');

      // Re-activate ownerUser, prepare another assigned route and verify disabled courier rejection.
      setActorActive(ownerUser.actorId, true);
      const otherUser = createFixtureActor('repartidor', true);
      const otherRoute = await prepareAssignedRoute(database, {
        courierUserId: otherUser.actorId,
      });
      const staffUser = createFixtureActor('personal', true);
      const staffApp = buildApp(database, staffUser.actorId);
      for (const [status, expectedVersion] of [
        ['recogido', '2'],
        ['en_camino', '3'],
        ['entregado', '4'],
      ] as const) {
        expect(
          (
            await request(staffApp)
              .post('/delivery-status-changes')
              .set('Idempotency-Key', randomUUID())
              .send({
                orderId: otherRoute.orderIds[0],
                newStatus: status,
                expectedVersion,
              })
          ).status,
        ).toBe(200);
      }

      // Disabled courier without route assignment gets 403.
      const thirdUser = createFixtureActor('repartidor', true);
      const thirdCourier = await createLinkedCourier(database, {
        userId: thirdUser.actorId,
      });
      disableCourier(thirdCourier);
      const thirdApp = buildApp(database, thirdUser.actorId);
      const thirdCompletion = await request(thirdApp)
        .post('/route-completions')
        .send({ routeId: otherRoute.routeId });
      expect(thirdCompletion.status).toBe(403);
      expect(thirdCompletion.body.code).toBe('FORBIDDEN');

      // Complete otherRoute via staff, then disable otherRoute's courier and verify 403 on subsequent access.
      expect(
        (
          await request(staffApp)
            .post('/route-completions')
            .send({ routeId: otherRoute.routeId })
        ).status,
      ).toBe(200);
      disableCourier(otherRoute.courierId);
      const otherApp = buildApp(database, otherUser.actorId);
      const disabledAttempt = await request(otherApp)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({
          orderId: otherRoute.orderIds[0],
          newStatus: 'entregado',
          expectedVersion: '5',
        });
      expect(disabledAttempt.status).toBe(403);
      expect(disabledAttempt.body.code).toBe('FORBIDDEN');
    });

    it('resuelve competencia concurrente sobre versión con dos conexiones PostgreSQL distintas', async () => {
      const firstPid = await database.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `;
      const secondPid = await secondDatabase.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `;
      expect(firstPid[0]!.pid).not.toBe(secondPid[0]!.pid);

      const courierUser = createFixtureActor('repartidor', true);
      const staffUser = createFixtureActor('personal', true);
      const assigned = await prepareAssignedRoute(database, {
        courierUserId: courierUser.actorId,
      });
      const orderId = assigned.orderIds[0]!;

      const firstApp = buildApp(database, courierUser.actorId);
      const secondApp = buildApp(secondDatabase, staffUser.actorId);

      const responses = await Promise.all([
        request(firstApp)
          .post('/delivery-status-changes')
          .set('Idempotency-Key', randomUUID())
          .send({ orderId, newStatus: 'recogido', expectedVersion: '2' }),
        request(secondApp)
          .post('/delivery-status-changes')
          .set('Idempotency-Key', randomUUID())
          .send({ orderId, newStatus: 'recogido', expectedVersion: '2' }),
      ]);

      expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
      const winner = responses.find(res => res.status === 200)!;
      const loser = responses.find(res => res.status === 409)!;
      expect(winner.body).toEqual({
        orderId,
        status: 'recogido',
        version: '3',
      });
      expect(loser.body.code).toBe('DATA_CONFLICT');

      const audit = await readOrderAuditSnapshot(database, orderId);
      expect(audit.orderVersion).toBe('3');
      expect(audit.outboxEvents).toHaveLength(3);
    });

    it('valida entradas, not found, JSON malformado, límite 32 KB y traduce fallo DB a 503', async () => {
      const staffUser = createFixtureActor('personal', true);
      const app = buildApp(database, staffUser.actorId);
      const pending = await prepareUnassignedOrder(database);

      // 404 for nonexistent order/route on mutations.
      const missingOrder = await request(app)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({
          orderId: randomUUID(),
          newStatus: 'recogido',
          expectedVersion: '1',
        });
      expect(missingOrder.status).toBe(404);
      expect(missingOrder.body.code).toBe('ORDER_NOT_FOUND');

      const missingRoute = await request(app)
        .post('/route-completions')
        .send({ routeId: randomUUID() });
      expect(missingRoute.status).toBe(404);
      expect(missingRoute.body.code).toBe('ROUTE_NOT_FOUND');

      // Missing / invalid Idempotency-Key and malformed body fields -> 400.
      const noKey = await request(app)
        .post('/delivery-status-changes')
        .send({
          orderId: pending.orderId,
          newStatus: 'recogido',
          expectedVersion: '1',
        });
      expect(noKey.status).toBe(400);
      expect(noKey.body.code).toBe('VALIDATION_ERROR');

      for (const payload of [
        { orderId: 'bad', newStatus: 'recogido', expectedVersion: '1' },
        { orderId: pending.orderId, newStatus: 'pendiente', expectedVersion: '1' },
        { orderId: pending.orderId, newStatus: 'recogido', expectedVersion: 1 },
        { orderId: pending.orderId, newStatus: 'recogido', expectedVersion: '0' },
        { orderId: pending.orderId, newStatus: 'recogido', expectedVersion: '01' },
        { orderId: pending.orderId, newStatus: 'recogido', expectedVersion: '-1' },
        {
          orderId: pending.orderId,
          newStatus: 'recogido',
          expectedVersion: '9223372036854775808',
        },
        null,
        [],
      ]) {
        const res = await request(app)
          .post('/delivery-status-changes')
          .set('Idempotency-Key', randomUUID())
          .set('Content-Type', 'application/json')
          .send(JSON.stringify(payload));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }

      // Large positive 64-bit decimal version > Number.MAX_SAFE_INTEGER is accepted as bigint string (fails 409, not 400).
      const bigIntVersion = await request(app)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .send({
          orderId: pending.orderId,
          newStatus: 'recogido',
          expectedVersion: '9007199254740993',
        });
      expect(bigIntVersion.status).toBe(409);
      expect(bigIntVersion.body.code).toBe('DATA_CONFLICT');

      expect(
        (
          await request(app)
            .post('/route-completions')
            .send({ routeId: 'bad-uuid' })
        ).status,
      ).toBe(400);

      const malformedJson = await request(app)
        .post('/delivery-status-changes')
        .set('Idempotency-Key', randomUUID())
        .set('Content-Type', 'application/json')
        .send('{');
      expect(malformedJson.status).toBe(400);
      expect(malformedJson.body.code).toBe('VALIDATION_ERROR');

      const oversized = await request(app)
        .post('/route-completions')
        .send({ routeId: randomUUID(), extra: 'x'.repeat(33_000) });
      expect(oversized.status).toBe(413);
      expect(oversized.body.code).toBe('VALIDATION_ERROR');

      // Disconnected DB returns sanitized 503.
      const badUrl = new URL(process.env['TEST_DATABASE_URL']!);
      badUrl.port = '1';
      const disconnected = createDatabaseClient(badUrl.toString());
      try {
        const brokenApp = buildApp(disconnected, staffUser.actorId);
        const res = await request(brokenApp).get(
          `/delivery-orders/${pending.orderId}`,
        );
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('PERSISTENCE_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(
          /postgresql|SQLSTATE|password|127\.0\.0\.1/,
        );
      } finally {
        await disconnected.$disconnect();
      }
    });
  });
});

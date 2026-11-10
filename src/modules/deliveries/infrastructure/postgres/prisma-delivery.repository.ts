import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { DeliveryRepository } from '../../application/ports/delivery.repository.js';
import { assertActorActive, assertCanCompleteRoute } from '../../domain/actor.js';
import { DeliveryError } from '../../domain/delivery.errors.js';
import {
  assertActorCanChangeOrderStatus,
  assertRouteCompletable,
  validateOrderStatus,
  type DeliveryOrder,
  type DeliveryStatusChangeCommand,
  type DeliveryStatusChangeResult,
  type RouteCompletionResult,
} from '../../domain/delivery-order.js';
import { mapDeliveryPersistenceError } from './delivery-persistence.errors.js';
import {
  mapActorRow,
  mapDeliveryOrderRow,
  mapStatusChangeResultRow,
} from './delivery.mapper.js';

interface OrderStopOwnershipRow {
  readonly courierUserId: string | null;
  readonly courierEnabled: boolean;
}

interface RouteHeaderRow {
  readonly id: string;
  readonly status: string;
  readonly courierUserId: string | null;
  readonly courierEnabled: boolean;
}

export class PrismaDeliveryRepository implements DeliveryRepository {
  constructor(private readonly database: PrismaDatabaseClient) {}

  async findOrderById(orderId: string): Promise<DeliveryOrder | null> {
    try {
      const rows = await this.database.$queryRaw<unknown[]>`
        SELECT
          o.id::text AS "orderId",
          s.route_id::text AS "routeId",
          o.status AS "status",
          o.version::text AS "version",
          o.delivered_at AS "deliveredAt",
          o.updated_at AS "updatedAt"
        FROM logistica.orders o
        LEFT JOIN logistica.current_route_stops s ON s.order_id = o.id
        WHERE o.id = ${orderId}::uuid
      `;
      if (!rows[0]) {
        return null;
      }
      return mapDeliveryOrderRow(rows[0]);
    } catch (error: unknown) {
      mapDeliveryPersistenceError(error);
    }
  }

  async changeOrderStatus(
    actorId: string,
    command: DeliveryStatusChangeCommand,
  ): Promise<DeliveryStatusChangeResult> {
    try {
      return await this.database.$transaction(async client => {
        await client.$queryRaw`
          SELECT 1 AS ok
          FROM pg_advisory_xact_lock(hashtextextended(${command.orderId}::text, 4))
        `;

        const actorRows = await client.$queryRaw<unknown[]>`
          SELECT id::text AS "id", auth_subject AS "authSubject", role, is_active AS "isActive"
          FROM logistica.app_users
          WHERE id = ${actorId}::uuid
        `;
        if (!actorRows[0]) {
          assertActorActive(null);
        }
        const actor = mapActorRow(actorRows[0]);
        assertActorActive(actor);

        const orderRows = await client.$queryRaw<{ id: string }[]>`
          SELECT id::text AS "id"
          FROM logistica.orders
          WHERE id = ${command.orderId}::uuid
        `;
        if (!orderRows[0]) {
          throw new DeliveryError('ORDER_NOT_FOUND');
        }

        if (actor.role === 'repartidor') {
          const stopRows = await client.$queryRaw<OrderStopOwnershipRow[]>`
            SELECT c.user_id::text AS "courierUserId", COALESCE(c.is_enabled, false) AS "courierEnabled"
            FROM logistica.route_stops s
            JOIN logistica.routes r ON r.id = s.route_id
            LEFT JOIN logistica.couriers c ON c.id = r.courier_id
            WHERE s.order_id = ${command.orderId}::uuid
              AND (s.released_at IS NULL OR s.release_reason = 'ruta_completada')
            ORDER BY (s.released_at IS NULL) DESC, s.added_at DESC
            LIMIT 1
          `;
          const stop = stopRows[0];
          assertActorCanChangeOrderStatus(actor, {
            assigned: Boolean(stop),
            courierUserId: stop?.courierUserId ?? null,
            courierEnabled: stop?.courierEnabled ?? false,
          });
        }

        const resultRows = await client.$queryRaw<unknown[]>`
          SELECT
            res->>'orderId' AS "orderId",
            res->>'status' AS "status",
            res->>'version' AS "version"
          FROM logistica.change_status_once(
            ${command.orderId}::uuid,
            ${command.newStatus}::text,
            ${command.expectedVersion}::bigint,
            ${actorId}::uuid,
            ${command.idempotencyKey}::uuid
          ) AS res
        `;
        return mapStatusChangeResultRow(resultRows[0], command.orderId);
      });
    } catch (error: unknown) {
      mapDeliveryPersistenceError(error);
    }
  }

  async completeRoute(
    actorId: string,
    routeId: string,
  ): Promise<RouteCompletionResult> {
    try {
      return await this.database.$transaction(async client => {
        await client.$queryRaw`
          SELECT 1 AS ok
          FROM pg_advisory_xact_lock(hashtextextended(${routeId}::text, 3))
        `;

        const actorRows = await client.$queryRaw<unknown[]>`
          SELECT id::text AS "id", auth_subject AS "authSubject", role, is_active AS "isActive"
          FROM logistica.app_users
          WHERE id = ${actorId}::uuid
        `;
        if (!actorRows[0]) {
          assertActorActive(null);
        }
        const actor = mapActorRow(actorRows[0]);
        assertActorActive(actor);

        const routeRows = await client.$queryRaw<RouteHeaderRow[]>`
          SELECT
            r.id::text AS "id",
            r.status AS "status",
            c.user_id::text AS "courierUserId",
            COALESCE(c.is_enabled, false) AS "courierEnabled"
          FROM logistica.routes r
          LEFT JOIN logistica.couriers c ON c.id = r.courier_id
          WHERE r.id = ${routeId}::uuid
        `;
        const route = routeRows[0];
        if (!route) {
          throw new DeliveryError('ROUTE_NOT_FOUND');
        }

        assertCanCompleteRoute(actor, route.courierUserId, route.courierEnabled);

        const stopRows = await client.$queryRaw<{ status: string }[]>`
          SELECT o.status AS "status"
          FROM logistica.current_route_stops s
          JOIN logistica.orders o ON o.id = s.order_id
          WHERE s.route_id = ${routeId}::uuid
        `;
        const stopStatuses = stopRows.map(row => {
          try {
            return validateOrderStatus(row.status);
          } catch {
            throw new DeliveryError('PERSISTENCE_UNAVAILABLE');
          }
        });
        assertRouteCompletable(route.status, stopStatuses);

        await client.$queryRaw`
          SELECT set_config('logistica.actor_subject', ${actor.authSubject}::text, true)
        `;
        await client.$queryRaw`
          SELECT 1 AS ok
          FROM logistica.complete_route(${routeId}::uuid)
        `;

        return {
          routeId,
          status: 'completada',
        };
      });
    } catch (error: unknown) {
      mapDeliveryPersistenceError(error);
    }
  }
}

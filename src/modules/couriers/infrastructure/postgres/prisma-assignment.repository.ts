import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { AssignmentRepository } from '../../application/ports/assignment.repository.js';
import { assertAssignable, type AssignedRoute } from '../../domain/assignment.js';
import { CourierError } from '../../domain/courier.errors.js';
import { getCourier } from './prisma-courier.repository.js';
import { persistenceError } from './persistence-error.js';
interface RouteRecord { id: string; status: string; courier_id: string | null; capacity_limit: number; stop_count: number }
export class PrismaAssignmentRepository implements AssignmentRepository {
  constructor(private readonly database: PrismaDatabaseClient) {}
  async assign(routeId: string, courierId: string): Promise<void> {
    try {
      await this.database.$transaction(async client => {
        // App has SELECT + function EXECUTE, without table UPDATE permission.
        // Transaction advisory locks serialize this module's preconditions; SQL functions
        // retain row locks/constraints as the persistent defense. Fixed courier -> route order.
        await client.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${courierId}::text,1))`;
        await client.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${routeId}::text,2))`;
        const courier = await getCourier(client, courierId);
        const routes = await client.$queryRaw<RouteRecord[]>`
          SELECT r.id,r.status,r.courier_id,r.capacity_limit,
            (SELECT count(*)::integer FROM logistica.route_stops s WHERE s.route_id=r.id AND s.released_at IS NULL) AS stop_count
          FROM logistica.routes r WHERE r.id=${routeId}::uuid`;
        const route = routes[0];
        if (!route) throw new CourierError('ROUTE_NOT_FOUND');
        const eligibility = await client.$queryRaw<{ reserved: boolean; user_eligible: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM logistica.routes WHERE courier_id=c.id AND status IN ('asignada','en_curso')) AS reserved,
            (c.user_id IS NULL OR EXISTS(SELECT 1 FROM logistica.app_users u WHERE u.id=c.user_id AND u.is_active AND u.role='repartidor')) AS user_eligible
          FROM logistica.couriers c WHERE c.id=${courierId}::uuid`;
        const state = eligibility[0];
        if (!state) throw new CourierError('COURIER_NOT_FOUND');
        assertAssignable(courier, state.reserved, { status: route.status, courierId: route.courier_id, capacityLimit: route.capacity_limit, stopCount: route.stop_count }, state.user_eligible);
        await client.$queryRaw`SELECT 1 AS ok FROM logistica.assign_route(${routeId}::uuid,${courierId}::uuid)`;
      });
    } catch (error: unknown) { persistenceError(error); }
  }
  async getActiveRoute(courierId: string): Promise<AssignedRoute | null> {
    try {
      // One statement yields a consistent snapshot of existence, route and stops.
      const rows = await this.database.$queryRaw<{ item: AssignedRoute | null }[]>`
        SELECT (SELECT jsonb_build_object('routeId',r.id,'zoneId',r.zone_id,
          'serviceDate',to_char(r.service_date,'YYYY-MM-DD'),'status',r.status,
          'stops',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'orderId',o.id,'position',s.position,'deliveryAddress',o.delivery_address,
            'deliveryTime',to_char(o.delivery_time,'HH24:MI'),'status',o.status) ORDER BY s.position)
            FROM logistica.route_stops s JOIN logistica.orders o ON o.id=s.order_id
            WHERE s.route_id=r.id AND s.released_at IS NULL),'[]'::jsonb))
          FROM logistica.routes r WHERE r.courier_id=c.id AND r.status IN ('asignada','en_curso') LIMIT 1) AS item
        FROM logistica.couriers c WHERE c.id=${courierId}::uuid`;
      if (!rows[0]) throw new CourierError('COURIER_NOT_FOUND');
      return rows[0].item;
    } catch (error: unknown) { persistenceError(error); }
  }
}

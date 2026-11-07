import type { RouteListQuery, RoutePlanCommand } from '../../domain/route.entity.js';

export interface RouteSqlQuery {
  readonly strings: TemplateStringsArray;
  readonly values: readonly unknown[];
}

function sql(strings: TemplateStringsArray, ...values: unknown[]): RouteSqlQuery {
  return { strings, values };
}

// Only the original function and views granted to logistica_app; every value is a bound parameter.
export const logisticaRouteSql = {
  generatePlan(command: RoutePlanCommand): RouteSqlQuery {
    return sql`SELECT logistica.generate_routes(
      ${command.serviceDate}::date, ${command.capacityLimit}::integer, ${command.idempotencyKey}::uuid
    ) AS plan`;
  },

  list(query: RouteListQuery): RouteSqlQuery {
    const date = query.serviceDate ?? null;
    const zone = query.zoneId ?? null;
    return sql`SELECT id::text AS "id", zone_id::text AS "zoneId",
        to_char(service_date, 'YYYY-MM-DD') AS "serviceDate",
        capacity_limit AS "capacityLimit", status, courier_id::text AS "courierId",
        occupied_slots AS "occupiedSlots"
      FROM logistica.route_summary
      WHERE (${date}::date IS NULL OR service_date = ${date}::date)
        AND (${zone}::uuid IS NULL OR zone_id = ${zone}::uuid)
      ORDER BY id
      LIMIT ${query.limit}::integer OFFSET ${query.offset}::integer`;
  },

  // Route and current stops are read in one statement, so both come from the same snapshot.
  detail(id: string): RouteSqlQuery {
    return sql`SELECT r.id::text AS "id", r.zone_id::text AS "zoneId",
        to_char(r.service_date, 'YYYY-MM-DD') AS "serviceDate",
        r.capacity_limit AS "capacityLimit", r.status, r.courier_id::text AS "courierId",
        r.occupied_slots AS "occupiedSlots",
        COALESCE((
          SELECT json_agg(json_build_object(
              'orderId', s.order_id::text,
              'position', s.position::integer,
              'deliveryAddress', s.delivery_address,
              'deliveryDate', to_char(s.delivery_date, 'YYYY-MM-DD'),
              'deliveryTime', left(s.delivery_time::text, 5),
              'status', s.order_status,
              'zoneId', o.zone_id::text
            ) ORDER BY s.position)
          FROM logistica.current_route_stops s
          JOIN logistica.orders o ON o.id = s.order_id
          WHERE s.route_id = r.id
        ), '[]'::json) AS "stops"
      FROM logistica.route_summary r
      WHERE r.id = ${id}::uuid`;
  },
};

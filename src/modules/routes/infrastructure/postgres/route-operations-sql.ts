import type { RouteMoveCommand, StopOrderCommand } from '../../domain/route-operation.entity.js';
import type { RouteSqlQuery } from './route-sql.js';

function sql(strings: TemplateStringsArray, ...values: unknown[]): RouteSqlQuery {
  return { strings, values };
}

// Only original functions and views granted to logistica_app; every value is a bound parameter.
// Void functions are called in FROM so the driver reads an integer, never a void column.
export const logisticaRouteOperationsSql = {
  orderExists(orderId: string): RouteSqlQuery {
    return sql`SELECT EXISTS (SELECT 1 FROM logistica.orders WHERE id = ${orderId}::uuid) AS "exists"`;
  },

  routeExists(routeId: string): RouteSqlQuery {
    return sql`SELECT EXISTS (SELECT 1 FROM logistica.routes WHERE id = ${routeId}::uuid) AS "exists"`;
  },

  moveOrder(command: RouteMoveCommand): RouteSqlQuery {
    return sql`SELECT count(*)::integer AS "done"
      FROM logistica.move_order(${command.orderId}::uuid, ${command.destinationRouteId}::uuid)`;
  },

  currentRouteOfOrder(orderId: string): RouteSqlQuery {
    return sql`SELECT route_id::text AS "routeId"
      FROM logistica.current_route_stops WHERE order_id = ${orderId}::uuid`;
  },

  reorderRoute(command: StopOrderCommand): RouteSqlQuery {
    return sql`SELECT count(*)::integer AS "done"
      FROM logistica.reorder_route(${command.routeId}::uuid, ${[...command.orderIds]}::uuid[])`;
  },

  currentStopOrder(routeId: string): RouteSqlQuery {
    return sql`SELECT order_id::text AS "orderId"
      FROM logistica.current_route_stops WHERE route_id = ${routeId}::uuid ORDER BY position`;
  },
};

import { getRequestActor } from '../../../../bootstrap/auth.middleware.js';
import { orderSql, type AuthorizedOrderSql } from './order-sql.port.js';

export const logisticaOrderSql: AuthorizedOrderSql = {
  create(order) {
    const actor = getRequestActor();
    if (actor?.role === 'cliente') {
      return orderSql`SELECT logistica.create_order_for_customer(
        ${order.zoneId}::uuid, ${order.deliveryAddress}::text,
        ${order.deliveryDate}::date, ${order.deliveryTime}::time,
        NULL::text, NULL::text, NULL::text, ${actor.sub}::uuid
      ) AS id`;
    }
    return orderSql`SELECT logistica.create_order(
      ${order.zoneId}::uuid, ${order.deliveryAddress}::text,
      ${order.deliveryDate}::date, ${order.deliveryTime}::time
    ) AS id`;
  },
  find(filters) {
    const id = filters.id ?? null;
    const date = filters.deliveryDate ?? null;
    const zone = filters.zoneId ?? null;
    const actor = getRequestActor();
    const customerUserId = actor?.role === 'cliente' ? actor.sub : null;
    return orderSql`SELECT id, zone_id AS "zoneId", delivery_address AS "deliveryAddress",
      to_char(delivery_date, 'YYYY-MM-DD') AS "deliveryDate",
      left(delivery_time::text, 5) AS "deliveryTime", status,
      created_at AS "createdAt", updated_at AS "updatedAt"
      FROM logistica.orders
      WHERE (${id}::uuid IS NULL OR id = ${id}::uuid)
        AND (${date}::date IS NULL OR delivery_date = ${date}::date)
        AND (${zone}::uuid IS NULL OR zone_id = ${zone}::uuid)
        AND (${customerUserId}::uuid IS NULL OR customer_user_id = ${customerUserId}::uuid)
      ORDER BY created_at, id`;
  },
};

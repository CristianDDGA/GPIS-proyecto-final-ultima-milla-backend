import { loadRepresentativeFixture } from '../database.fixture.js';
import { routesDatabase } from '../sprint02/routes.fixture.js';

// Reuses the S2 Routes fixture (logistica_app client, zones, orders, Guayaquil dates) without copying it.
export {
  activeStopsPerOrder,
  closeRoutesDatabase,
  countRoutes,
  createOrder,
  createZone,
  guayaquilDate,
  orderStatuses,
  realDatabase,
  routesDatabase,
} from '../sprint02/routes.fixture.js';

// Rows of the original demo seed: an active 'personal' actor and two available couriers.
export const DEMO_STAFF_ACTOR = '30000000-0000-4000-8000-000000000001';
export const DEMO_COURIERS = ['40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002'] as const;

/**
 * Resets this run's ephemeral database and loads the original demo seed (the only source of an app_users actor,
 * which logistica_app cannot create). Demo couriers start unavailable so every test decides who can drive.
 */
export async function resetOperationsData(): Promise<void> {
  loadRepresentativeFixture();
  for (const courier of DEMO_COURIERS) await setCourierAvailability(courier, false);
}

async function single<T>(rows: Promise<T[]>, what: string): Promise<T> {
  const row = (await rows)[0];
  if (row === undefined) throw new Error(`${what} no devolvió resultado.`);
  return row;
}

// Every state below is prepared with original SQL functions under logistica_app; no direct table writes.
export async function createRoute(zoneId: string, date: string, capacity: number): Promise<string> {
  const row = await single(routesDatabase().$queryRaw<Array<{ id: string }>>`SELECT logistica.create_route(
    ${zoneId}::uuid, ${date}::date, ${capacity}::integer)::text AS id`, 'create_route');
  return row.id;
}

export async function addOrderToRoute(routeId: string, orderId: string): Promise<void> {
  await routesDatabase().$queryRaw`SELECT count(*)::integer AS done
    FROM logistica.add_order_to_route(${routeId}::uuid, ${orderId}::uuid)`;
}

export async function routeWithOrders(zoneId: string, date: string, capacity: number, orderIds: readonly string[]): Promise<string> {
  const routeId = await createRoute(zoneId, date, capacity);
  for (const orderId of orderIds) await addOrderToRoute(routeId, orderId);
  return routeId;
}

export async function createCourier(name: string, capacity: number, available: boolean): Promise<string> {
  const row = await single(routesDatabase().$queryRaw<Array<{ id: string }>>`SELECT logistica.create_courier(
    ${name}::text, ${capacity}::integer)::text AS id`, 'create_courier');
  if (available) await setCourierAvailability(row.id, true);
  return row.id;
}

export async function setCourierAvailability(courierId: string, available: boolean): Promise<void> {
  await routesDatabase().$queryRaw`SELECT count(*)::integer AS done
    FROM logistica.set_courier_availability(${courierId}::uuid, ${available}::boolean)`;
}

async function orderVersion(orderId: string): Promise<bigint> {
  const row = await single(routesDatabase().$queryRaw<Array<{ version: bigint | number }>>`SELECT version
    FROM logistica.orders WHERE id = ${orderId}::uuid`, 'version del pedido');
  return BigInt(row.version);
}

async function changeStatus(orderId: string, status: string): Promise<void> {
  const version = await orderVersion(orderId);
  await routesDatabase().$queryRaw`SELECT logistica.change_order_status(
    ${orderId}::uuid, ${status}::text, ${version}::bigint, ${DEMO_STAFF_ACTOR}::uuid)::text AS version`;
}

/**
 * Started route (en_curso) through the original flow, without the S3 Deliveries API: assign a courier, then the
 * first order goes recogido → en_camino, which moves the route to en_curso. Other stops stay asignado_a_ruta.
 */
export async function startRoute(routeId: string, firstOrderId: string): Promise<string> {
  const courierId = await createCourier(`Salida ${routeId.slice(0, 8)}`, 10, true);
  await routesDatabase().$queryRaw`SELECT count(*)::integer AS done
    FROM logistica.assign_route(${routeId}::uuid, ${courierId}::uuid)`;
  await changeStatus(firstOrderId, 'recogido');
  await changeStatus(firstOrderId, 'en_camino');
  return courierId;
}

export async function countOrders(): Promise<number> {
  const row = await single(routesDatabase().$queryRaw<Array<{ total: number }>>`SELECT count(*)::integer AS total
    FROM logistica.orders`, 'conteo de pedidos');
  return row.total;
}

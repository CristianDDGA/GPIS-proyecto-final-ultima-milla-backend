import { createDatabaseClient } from '../../../src/bootstrap/database.js';
import { realDatabase, resetTestData, setTestZoneInactive } from '../database.fixture.js';

export { realDatabase };

let database: ReturnType<typeof createDatabaseClient> | undefined;

// Application role only (logistica_app); the reset reuses the verified ephemeral-container helper.
export function routesDatabase(): ReturnType<typeof createDatabaseClient> {
  if (!realDatabase) throw new Error('Las pruebas de Routes requieren TEST_DATABASE_URL del harness PostgreSQL.');
  database ??= createDatabaseClient(process.env.TEST_DATABASE_URL!);
  return database;
}

export function resetRoutesData(): void {
  resetTestData();
}

export function deactivateZone(id: string): void {
  setTestZoneInactive(id);
}

export async function closeRoutesDatabase(): Promise<void> {
  await database?.$disconnect();
  database = undefined;
}

// Delivery days relative to the real day in Guayaquil, so create_order never sees a past date.
export function guayaquilDate(daysAhead: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + daysAhead * 86_400_000));
}

export async function createZone(name: string): Promise<string> {
  const rows = await routesDatabase().$queryRaw<Array<{ id: string }>>`SELECT logistica.create_zone(${name}::text)::text AS id`;
  const id = rows[0]?.id;
  if (!id) throw new Error('create_zone no devolvió identidad.');
  return id;
}

export async function createOrder(zoneId: string, address: string, date: string, time: string): Promise<string> {
  const rows = await routesDatabase().$queryRaw<Array<{ id: string }>>`SELECT logistica.create_order(
    ${zoneId}::uuid, ${address}::text, ${date}::date, ${time}::time)::text AS id`;
  const id = rows[0]?.id;
  if (!id) throw new Error('create_order no devolvió identidad.');
  return id;
}

export async function countRoutes(): Promise<number> {
  const rows = await routesDatabase().$queryRaw<Array<{ total: number }>>`SELECT count(*)::integer AS total FROM logistica.routes`;
  return rows[0]?.total ?? -1;
}

export async function orderStatuses(ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await routesDatabase().$queryRaw<Array<{ id: string; status: string }>>`SELECT id::text AS id, status
    FROM logistica.orders WHERE id = ANY(${[...ids]}::uuid[])`;
  return new Map(rows.map((row) => [row.id, row.status]));
}

export async function activeStopsPerOrder(): Promise<Array<{ orderId: string; total: number }>> {
  return routesDatabase().$queryRaw<Array<{ orderId: string; total: number }>>`SELECT order_id::text AS "orderId", count(*)::integer AS total
    FROM logistica.route_stops WHERE released_at IS NULL GROUP BY order_id`;
}

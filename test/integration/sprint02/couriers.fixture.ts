import { execFileSync } from 'node:child_process';
import { createDatabaseClient } from '../../../src/bootstrap/database.js';
import { resetTestData } from '../database.fixture.js';
import { validateId } from '../../../src/modules/couriers/domain/courier.js';
export { resetTestData };
export function courierDatabase() {
  const value = process.env['TEST_DATABASE_URL'];
  if (!value) throw new Error('PostgreSQL real requerido: ejecutar con scripts/run-postgres-integration.mjs.');
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/logistica_test') throw new Error('Solo destino temporal del harness.');
  return createDatabaseClient(value);
}
export type FixtureDatabase = ReturnType<typeof courierDatabase>;
export const serviceDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 2 * 86400000));
export async function preparedRoute(database: FixtureDatabase, orders = 1, capacity = Math.max(orders, 4)) {
  return database.$transaction(async client => {
    const zones = await client.$queryRaw<{ id: string }[]>`SELECT logistica.create_zone('Fixture S2') AS id`;
    const zoneId = zones[0]!.id;
    const routes = await client.$queryRaw<{ id: string }[]>`SELECT logistica.create_route(${zoneId}::uuid,${serviceDate}::date,${capacity}::integer) AS id`;
    const routeId = routes[0]!.id;
    const orderIds: string[] = [];
    for (let i = 0; i < orders; i++) {
      const rows = await client.$queryRaw<{ id: string }[]>`SELECT logistica.create_order(${zoneId}::uuid,'Dirección sintética S2',${serviceDate}::date,'09:30'::time) AS id`;
      const orderId = rows[0]!.id; orderIds.push(orderId);
      await client.$queryRaw`SELECT 1 AS ok FROM logistica.add_order_to_route(${routeId}::uuid,${orderId}::uuid)`;
    }
    return { routeId, zoneId, orderIds };
  });
}
export async function routeSnapshot(database: FixtureDatabase, routeId: string) {
  const rows = await database.$queryRaw<{ snapshot: unknown }[]>`
    SELECT jsonb_build_object('route',to_jsonb(r),'stops',
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.position) FROM logistica.route_stops s WHERE s.route_id=r.id),
      'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM logistica.orders o JOIN logistica.route_stops s ON s.order_id=o.id WHERE s.route_id=r.id),
      'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.route_version) FROM logistica.route_events e WHERE e.route_id=r.id)) AS snapshot
    FROM logistica.routes r WHERE r.id=${routeId}::uuid`;
  return rows[0]!.snapshot;
}
export function disableCourier(id: string): void {
  validateId(id);
  const container = process.env['TEST_DATABASE_CONTAINER'] ?? '';
  const project = process.env['TEST_DATABASE_PROJECT'] ?? '';
  if (!/^[a-f0-9]{12,64}$/.test(container) || !/^logistica_api_\d+_\d+$/.test(project)) throw new Error('Contenedor temporal requerido.');
  const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
  const owner = execFileSync(docker, ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container], { encoding: 'utf8' }).trim();
  if (owner !== project) throw new Error('Contenedor ajeno a esta ejecución.');
  execFileSync(docker, ['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'logistica_admin', '-d', 'logistica_test', '-c', `SET search_path=logistica,pg_catalog; UPDATE logistica.couriers SET is_enabled=false WHERE id='${id}'::uuid`], { stdio: 'pipe' });
}

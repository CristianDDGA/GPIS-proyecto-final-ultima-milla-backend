import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createDatabaseClient } from '../../../src/bootstrap/database.js';
import { AssignmentUseCases } from '../../../src/modules/couriers/application/assignment.use-cases.js';
import { PrismaAssignmentRepository } from '../../../src/modules/couriers/infrastructure/postgres/prisma-assignment.repository.js';
import type { ActorRole } from '../../../src/modules/deliveries/domain/actor.js';
import { resetTestData } from '../database.fixture.js';

export { resetTestData };

export function deliveryDatabase() {
  const value = process.env['TEST_DATABASE_URL'];
  if (!value) {
    throw new Error(
      'PostgreSQL real requerido: ejecutar con scripts/run-postgres-integration.mjs.',
    );
  }
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/logistica_test') {
    throw new Error('Solo destino temporal del harness.');
  }
  return createDatabaseClient(value);
}

export type FixtureDatabase = ReturnType<typeof deliveryDatabase>;

export const serviceDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Guayaquil',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(Date.now() + 2 * 86_400_000));

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_PATTERN = /^[a-zA-Z0-9._:-]+$/;

function assertUuid(id: string): string {
  if (!UUID_PATTERN.test(id)) {
    throw new Error('UUID de fixture inválido.');
  }
  return id.toLowerCase();
}

function runAdminSql(sql: string): string {
  const container = process.env['TEST_DATABASE_CONTAINER'] ?? '';
  const project = process.env['TEST_DATABASE_PROJECT'] ?? '';
  if (
    !/^[a-f0-9]{12,64}$/.test(container) ||
    !/^logistica_api_\d+_\d+$/.test(project)
  ) {
    throw new Error('Contenedor temporal requerido.');
  }
  const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
  const owner = execFileSync(
    docker,
    [
      'inspect',
      '--format',
      '{{index .Config.Labels "com.docker.compose.project"}}',
      container,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (owner !== project) {
    throw new Error('Contenedor ajeno a esta ejecución.');
  }
  return execFileSync(
    docker,
    [
      'exec',
      container,
      'psql',
      '-X',
      '-q',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'logistica_admin',
      '-d',
      'logistica_test',
      '-c',
      `SET search_path=logistica,pg_catalog; ${sql}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

export function createFixtureActor(
  role: ActorRole,
  isActive = true,
  subject = `${role}-${randomUUID()}`,
): { readonly actorId: string; readonly authSubject: string } {
  if (role !== 'personal' && role !== 'repartidor') {
    throw new Error('Rol de fixture inválido.');
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    throw new Error('Subject de fixture inválido.');
  }
  const activeLiteral = isActive ? 'true' : 'false';
  const actorId = runAdminSql(
    `INSERT INTO logistica.app_users(auth_subject, role, is_active) VALUES ('${subject}', '${role}', ${activeLiteral}) RETURNING id::text;`,
  )
    .split(/\r?\n/)
    .find(line => UUID_PATTERN.test(line.trim()))
    ?.trim();

  if (!actorId) {
    throw new Error('No se pudo crear actor de fixture.');
  }
  return { actorId: assertUuid(actorId), authSubject: subject };
}

export function setActorActive(actorId: string, isActive: boolean): void {
  const cleanId = assertUuid(actorId);
  const activeLiteral = isActive ? 'true' : 'false';
  runAdminSql(
    `UPDATE logistica.app_users SET is_active=${activeLiteral} WHERE id='${cleanId}'::uuid;`,
  );
}

export function disableCourier(courierId: string): void {
  const cleanId = assertUuid(courierId);
  runAdminSql(
    `UPDATE logistica.couriers SET is_enabled=false WHERE id='${cleanId}'::uuid;`,
  );
}

export async function createLinkedCourier(
  database: FixtureDatabase,
  options: {
    readonly userId: string | null;
    readonly displayName?: string;
    readonly maxOrdersPerTrip?: number;
    readonly available?: boolean;
  },
): Promise<string> {
  const displayName = options.displayName ?? 'Repartidor S3';
  const capacity = options.maxOrdersPerTrip ?? 5;
  const userId = options.userId ? assertUuid(options.userId) : null;

  const created = await database.$queryRaw<{ id: string }[]>`
    SELECT logistica.create_courier(${displayName}::text, ${capacity}::integer, ${userId}::uuid) AS id
  `;
  const courierId = created[0]!.id;

  if (options.available ?? true) {
    await database.$queryRaw`
      SELECT 1 AS ok FROM logistica.set_courier_availability(${courierId}::uuid, true)
    `;
  }
  return courierId;
}

export async function prepareUnassignedOrder(
  database: FixtureDatabase,
): Promise<{ readonly zoneId: string; readonly orderId: string }> {
  return database.$transaction(async client => {
    const zones = await client.$queryRaw<{ id: string }[]>`
      SELECT logistica.create_zone('Zona Fixture S3') AS id
    `;
    const zoneId = zones[0]!.id;
    const orders = await client.$queryRaw<{ id: string }[]>`
      SELECT logistica.create_order(
        ${zoneId}::uuid,
        'Av. Principal S3',
        ${serviceDate}::date,
        '10:00'::time
      ) AS id
    `;
    return { zoneId, orderId: orders[0]!.id };
  });
}

export async function prepareAssignedRoute(
  database: FixtureDatabase,
  options: {
    readonly courierUserId: string;
    readonly orderCount?: number;
    readonly capacity?: number;
    readonly courierCapacity?: number;
  },
): Promise<{
  readonly routeId: string;
  readonly zoneId: string;
  readonly courierId: string;
  readonly orderIds: readonly string[];
}> {
  const orderCount = options.orderCount ?? 1;
  const capacity = options.capacity ?? Math.max(orderCount, 4);
  const courierId = await createLinkedCourier(database, {
    userId: options.courierUserId,
    maxOrdersPerTrip: options.courierCapacity ?? Math.max(capacity, 4),
    available: true,
  });

  const prepared = await database.$transaction(async client => {
    const zones = await client.$queryRaw<{ id: string }[]>`
      SELECT logistica.create_zone('Zona Ruta S3') AS id
    `;
    const zoneId = zones[0]!.id;
    const routes = await client.$queryRaw<{ id: string }[]>`
      SELECT logistica.create_route(${zoneId}::uuid, ${serviceDate}::date, ${capacity}::integer) AS id
    `;
    const routeId = routes[0]!.id;
    const orderIds: string[] = [];
    for (let index = 0; index < orderCount; index++) {
      const orders = await client.$queryRaw<{ id: string }[]>`
        SELECT logistica.create_order(
          ${zoneId}::uuid,
          ${`Calle Entrega S3 #${index + 1}`}::text,
          ${serviceDate}::date,
          '10:30'::time
        ) AS id
      `;
      const orderId = orders[0]!.id;
      orderIds.push(orderId);
      await client.$queryRaw`
        SELECT 1 AS ok FROM logistica.add_order_to_route(${routeId}::uuid, ${orderId}::uuid)
      `;
    }
    return { routeId, zoneId, orderIds };
  });

  // Reuse S2 Couriers assignment module to bind the route and courier atomically.
  const assignments = new AssignmentUseCases(new PrismaAssignmentRepository(database));
  await assignments.assign(prepared.routeId, courierId);
  const activeRoute = await assignments.getRoute(courierId);
  if (!activeRoute.item || activeRoute.item.routeId !== prepared.routeId) {
    throw new Error('Ruta activa S2 no encontrada tras asignación.');
  }

  return {
    routeId: prepared.routeId,
    zoneId: prepared.zoneId,
    courierId,
    orderIds: prepared.orderIds,
  };
}

export async function preparePlannedRoute(
  database: FixtureDatabase,
  orderCount = 1,
): Promise<{
  readonly routeId: string;
  readonly zoneId: string;
  readonly orderIds: readonly string[];
}> {
  return database.$transaction(async client => {
    const zones = await client.$queryRaw<{ id: string }[]>`
      SELECT logistica.create_zone('Zona Planificada S3') AS id
    `;
    const zoneId = zones[0]!.id;
    const routes = await client.$queryRaw<{ id: string }[]>`
      SELECT logistica.create_route(${zoneId}::uuid, ${serviceDate}::date, ${Math.max(orderCount, 2)}::integer) AS id
    `;
    const routeId = routes[0]!.id;
    const orderIds: string[] = [];
    for (let index = 0; index < orderCount; index++) {
      const orders = await client.$queryRaw<{ id: string }[]>`
        SELECT logistica.create_order(
          ${zoneId}::uuid,
          ${`Calle Plan S3 #${index + 1}`}::text,
          ${serviceDate}::date,
          '11:00'::time
        ) AS id
      `;
      const orderId = orders[0]!.id;
      orderIds.push(orderId);
      await client.$queryRaw`
        SELECT 1 AS ok FROM logistica.add_order_to_route(${routeId}::uuid, ${orderId}::uuid)
      `;
    }
    return { routeId, zoneId, orderIds };
  });
}

export interface OrderAuditSnapshot {
  readonly orderStatus: string;
  readonly orderVersion: string;
  readonly routeStatus: string | null;
  readonly orderEvents: ReadonlyArray<{
    readonly orderVersion: string;
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly actorSubject: string | null;
    readonly source: string;
  }>;
  readonly outboxEvents: ReadonlyArray<{
    readonly aggregateVersion: string;
    readonly eventType: string;
    readonly payloadStatus: string;
  }>;
}

export async function readOrderAuditSnapshot(
  database: FixtureDatabase,
  orderId: string,
): Promise<OrderAuditSnapshot> {
  const cleanOrderId = assertUuid(orderId);
  const orderRows = await database.$queryRaw<
    { status: string; version: string; routeStatus: string | null }[]
  >`
    SELECT o.status, o.version::text AS "version", r.status AS "routeStatus"
    FROM logistica.orders o
    LEFT JOIN logistica.current_route_stops s ON s.order_id = o.id
    LEFT JOIN logistica.routes r ON r.id = s.route_id
    WHERE o.id = ${cleanOrderId}::uuid
  `;
  const orderRow = orderRows[0];
  if (!orderRow) {
    throw new Error('Pedido no encontrado en snapshot.');
  }

  const orderEvents = await database.$queryRaw<
    {
      orderVersion: string;
      fromStatus: string | null;
      toStatus: string;
      actorSubject: string | null;
      source: string;
    }[]
  >`
    SELECT
      order_version::text AS "orderVersion",
      from_status AS "fromStatus",
      to_status AS "toStatus",
      actor_subject AS "actorSubject",
      source
    FROM logistica.order_events
    WHERE order_id = ${cleanOrderId}::uuid
    ORDER BY order_version ASC
  `;

  // logistica_app lacks SELECT on outbox_events; fixture queries isolated test container via admin.
  const outboxJson = runAdminSql(
    `SELECT COALESCE(json_agg(json_build_object('aggregateVersion', aggregate_version::text, 'eventType', event_type, 'payloadStatus', payload->>'status') ORDER BY aggregate_version ASC), '[]'::json)::text FROM logistica.outbox_events WHERE order_id = '${cleanOrderId}'::uuid;`,
  )
    .split(/\r?\n/)
    .find(line => line.trim().startsWith('['))
    ?.trim();

  const outboxEvents = (outboxJson ? JSON.parse(outboxJson) : []) as OrderAuditSnapshot['outboxEvents'];

  return {
    orderStatus: orderRow.status,
    orderVersion: orderRow.version,
    routeStatus: orderRow.routeStatus,
    orderEvents,
    outboxEvents,
  };
}

export async function readRouteAuditSnapshot(
  database: FixtureDatabase,
  routeId: string,
): Promise<{
  readonly routeStatus: string;
  readonly routeVersion: string;
  readonly completedAt: string | null;
  readonly activeStopCount: number;
  readonly routeEvents: ReadonlyArray<{
    readonly routeVersion: string;
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly actorSubject: string | null;
  }>;
  readonly outboxEvents: ReadonlyArray<{
    readonly aggregateVersion: string;
    readonly eventType: string;
    readonly payloadStatus: string;
  }>;
}> {
  const cleanRouteId = assertUuid(routeId);
  const routeRows = await database.$queryRaw<
    {
      status: string;
      version: string;
      completedAt: Date | null;
      activeStopCount: number;
    }[]
  >`
    SELECT
      r.status,
      r.version::text AS "version",
      r.completed_at AS "completedAt",
      (SELECT count(*)::integer FROM logistica.route_stops s WHERE s.route_id = r.id AND s.released_at IS NULL) AS "activeStopCount"
    FROM logistica.routes r
    WHERE r.id = ${cleanRouteId}::uuid
  `;
  const routeRow = routeRows[0];
  if (!routeRow) {
    throw new Error('Ruta no encontrada en snapshot.');
  }

  const routeEvents = await database.$queryRaw<
    {
      routeVersion: string;
      fromStatus: string | null;
      toStatus: string;
      actorSubject: string | null;
    }[]
  >`
    SELECT
      route_version::text AS "routeVersion",
      from_status AS "fromStatus",
      to_status AS "toStatus",
      actor_subject AS "actorSubject"
    FROM logistica.route_events
    WHERE route_id = ${cleanRouteId}::uuid
    ORDER BY route_version ASC
  `;

  const outboxJson = runAdminSql(
    `SELECT COALESCE(json_agg(json_build_object('aggregateVersion', aggregate_version::text, 'eventType', event_type, 'payloadStatus', payload->>'status') ORDER BY aggregate_version ASC), '[]'::json)::text FROM logistica.outbox_events WHERE route_id = '${cleanRouteId}'::uuid;`,
  )
    .split(/\r?\n/)
    .find(line => line.trim().startsWith('['))
    ?.trim();

  const outboxEvents = (outboxJson ? JSON.parse(outboxJson) : []) as Array<{
    readonly aggregateVersion: string;
    readonly eventType: string;
    readonly payloadStatus: string;
  }>;

  return {
    routeStatus: routeRow.status,
    routeVersion: routeRow.version,
    completedAt: routeRow.completedAt ? routeRow.completedAt.toISOString() : null,
    activeStopCount: routeRow.activeStopCount,
    routeEvents,
    outboxEvents,
  };
}

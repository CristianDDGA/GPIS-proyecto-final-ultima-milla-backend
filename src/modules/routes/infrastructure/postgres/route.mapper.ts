import type { RouteStatus, RouteStopRecord, RouteSummary, StopOrderStatus } from '../../domain/route.entity.js';
import { RoutePersistenceUnavailableError } from '../../domain/route.errors.js';

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RoutePersistenceUnavailableError();
  return value as Row;
}

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new RoutePersistenceUnavailableError();
  return value;
}

function integer(row: Row, field: string): number {
  const raw = row[field];
  const value = typeof raw === 'bigint' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new RoutePersistenceUnavailableError();
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new RoutePersistenceUnavailableError(); }
}

export function mapRouteSummary(value: unknown): RouteSummary {
  const row = asRow(value);
  const courierId = row['courierId'];
  if (courierId !== null && typeof courierId !== 'string') throw new RoutePersistenceUnavailableError();
  return {
    id: text(row, 'id'),
    zoneId: text(row, 'zoneId'),
    serviceDate: text(row, 'serviceDate'),
    capacityLimit: integer(row, 'capacityLimit'),
    status: text(row, 'status') as RouteStatus,
    courierId,
    occupiedSlots: integer(row, 'occupiedSlots'),
  };
}

export function mapRouteStops(value: unknown): RouteStopRecord[] {
  const stops = parseJson(value);
  if (!Array.isArray(stops)) throw new RoutePersistenceUnavailableError();
  return stops.map((item) => {
    const row = asRow(item);
    return {
      orderId: text(row, 'orderId'),
      position: integer(row, 'position'),
      deliveryAddress: text(row, 'deliveryAddress'),
      deliveryDate: text(row, 'deliveryDate'),
      deliveryTime: text(row, 'deliveryTime'),
      status: text(row, 'status') as StopOrderStatus,
      zoneId: text(row, 'zoneId'),
    };
  });
}

// generate_routes returns jsonb {date, routeIds}; date becomes serviceDate at this boundary.
export function mapPlanResult(value: unknown): { serviceDate: unknown; routeIds: unknown } {
  const plan = asRow(parseJson(asRow(value)['plan']));
  return { serviceDate: plan['date'], routeIds: plan['routeIds'] };
}

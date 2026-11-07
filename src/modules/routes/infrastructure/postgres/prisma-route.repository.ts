import type { PrismaQueryClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { RouteListQuery, RoutePlanCommand, RouteSummary } from '../../domain/route.entity.js';
import { RoutePersistenceUnavailableError } from '../../domain/route.errors.js';
import type { RouteDetailRecord, RouteRepository } from '../../application/ports/route.repository.port.js';
import { logisticaRouteSql, type RouteSqlQuery } from './route-sql.js';
import { mapPlanResult, mapRouteStops, mapRouteSummary } from './route.mapper.js';
import { throwRoutePersistenceError } from './route-persistence.errors.js';

export class PrismaRouteRepository implements RouteRepository {
  constructor(private readonly prisma: PrismaQueryClient) {}

  // generate_routes is atomic and idempotent by itself: it locks the day and records the key.
  async generatePlan(command: RoutePlanCommand): Promise<{ serviceDate: unknown; routeIds: unknown }> {
    try {
      const rows = await this.execute(logisticaRouteSql.generatePlan(command));
      if (rows.length !== 1) throw new RoutePersistenceUnavailableError();
      return mapPlanResult(rows[0]);
    } catch (error: unknown) {
      throwRoutePersistenceError(error);
    }
  }

  async list(query: RouteListQuery): Promise<readonly RouteSummary[]> {
    try {
      return (await this.execute(logisticaRouteSql.list(query))).map(mapRouteSummary);
    } catch (error: unknown) {
      throwRoutePersistenceError(error);
    }
  }

  async findDetail(id: string): Promise<RouteDetailRecord | null> {
    try {
      const rows = await this.execute(logisticaRouteSql.detail(id));
      if (rows.length > 1) throw new RoutePersistenceUnavailableError();
      const row = rows[0];
      if (row === undefined) return null;
      return { route: mapRouteSummary(row), stops: mapRouteStops((row as Record<string, unknown>)['stops']) };
    } catch (error: unknown) {
      throwRoutePersistenceError(error);
    }
  }

  private async execute(statement: RouteSqlQuery): Promise<readonly unknown[]> {
    if (statement.strings.length !== statement.values.length + 1 || !Array.isArray(statement.strings.raw)) {
      throw new RoutePersistenceUnavailableError();
    }
    const records = await this.prisma.$queryRaw<unknown>(statement.strings, ...statement.values);
    if (!Array.isArray(records)) throw new RoutePersistenceUnavailableError();
    return records;
  }
}

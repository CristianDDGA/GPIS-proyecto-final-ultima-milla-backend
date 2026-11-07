import type { RouteListQuery, RoutePlanCommand, RouteStopRecord, RouteSummary } from '../../domain/route.entity.js';

export interface RouteDetailRecord {
  readonly route: RouteSummary;
  readonly stops: readonly RouteStopRecord[];
}

// Minimal persistence port: one planning command and two read projections.
export interface RouteRepository {
  generatePlan(command: RoutePlanCommand): Promise<{ readonly serviceDate: unknown; readonly routeIds: unknown }>;
  list(query: RouteListQuery): Promise<readonly RouteSummary[]>;
  findDetail(id: string): Promise<RouteDetailRecord | null>;
}

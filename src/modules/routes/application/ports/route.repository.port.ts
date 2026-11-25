import type { RouteListQuery, RoutePlanCommand, RouteStopRecord, RouteSummary } from '../../domain/route.entity.js';

export interface RouteDetailRecord {
  readonly route: RouteSummary;
  readonly stops: readonly RouteStopRecord[];
}

// Minimal persistence port: one planning command and two read projections.
export interface RouteRepository {
  generatePlan(command: RoutePlanCommand): Promise<{ readonly serviceDate: unknown; readonly routeIds: unknown }>;
  /** Solo lectura: lo que generaría `generatePlan` con los mismos datos (devuelve el JSON crudo de la base). */
  previewPlan(command: { readonly serviceDate: string; readonly capacityLimit: number }): Promise<unknown>;
  list(query: RouteListQuery): Promise<readonly RouteSummary[]>;
  findDetail(id: string): Promise<RouteDetailRecord | null>;
}

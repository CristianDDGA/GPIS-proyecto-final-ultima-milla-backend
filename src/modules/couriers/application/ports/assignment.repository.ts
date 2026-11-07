import type { AssignedRoute } from '../../domain/assignment.js';
export interface AssignmentRepository {
  assign(routeId: string, courierId: string): Promise<void>;
  getActiveRoute(courierId: string): Promise<AssignedRoute | null>;
}

import type { LatePlacementCommand } from '../../domain/route-operation.entity.js';

// place_late_order is atomic and idempotent by itself; the port returns its stored jsonb answer untouched.
// A missing order raises RouteOrderNotFoundError.
export interface LatePlacementRepository {
  placeLateOrder(command: LatePlacementCommand): Promise<{ readonly placement: unknown }>;
}

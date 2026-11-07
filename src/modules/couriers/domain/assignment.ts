import type { Courier } from './courier.js';
import { isEligible } from './courier.js';
import { CourierError } from './courier.errors.js';
export interface AssignableRoute { readonly status: string; readonly courierId: string | null; readonly capacityLimit: number; readonly stopCount: number }
export function assertAssignable(courier: Courier, hasActiveRoute: boolean, route: AssignableRoute, userEligible: boolean): void {
  if (!isEligible(courier, hasActiveRoute) || !userEligible || route.status !== 'planificada' || route.courierId !== null ||
      route.stopCount < 1 || route.stopCount > Math.min(courier.maxOrdersPerTrip, route.capacityLimit)) {
    throw new CourierError('DATA_CONFLICT');
  }
}
export interface AssignedRoute {
  readonly routeId: string; readonly zoneId: string; readonly serviceDate: string; readonly status: string;
  readonly stops: readonly { readonly orderId: string; readonly position: number; readonly deliveryAddress: string; readonly deliveryTime: string; readonly status: string }[];
}

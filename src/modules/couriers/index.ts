import type { CourierRepository } from './application/ports/courier.repository.js';
import type { AssignmentRepository } from './application/ports/assignment.repository.js';
import { CourierUseCases } from './application/courier.use-cases.js';
import { AssignmentUseCases } from './application/assignment.use-cases.js';
import { createCourierRouter, courierErrorHandler } from './presentation/http/courier.router.js';
export function createCouriersModule(dependencies: { couriers: CourierRepository; assignments: AssignmentRepository }) {
  const couriers = new CourierUseCases(dependencies.couriers);
  const assignments = new AssignmentUseCases(dependencies.assignments);
  return { router: createCourierRouter(couriers, assignments), errorHandler: courierErrorHandler, useCases: { couriers, assignments } };
}

import type { AssignmentRepository } from './ports/assignment.repository.js';
import { validateId } from '../domain/courier.js';
export class AssignmentUseCases {
  constructor(private readonly repository: AssignmentRepository) {}
  async assign(route: unknown, courier: unknown) {
    const routeId = validateId(route); const courierId = validateId(courier);
    await this.repository.assign(routeId, courierId);
    return { routeId, courierId, status: 'asignada' as const };
  }
  async getRoute(id: unknown) { return { item: await this.repository.getActiveRoute(validateId(id)) }; }
}

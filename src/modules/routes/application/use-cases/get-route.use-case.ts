import { RoutePlanning, type RouteDetail } from '../../domain/route.entity.js';
import { RouteNotFoundError } from '../../domain/route.errors.js';
import { validateUuid } from '../../domain/route.validation.js';
import type { RouteRepository } from '../ports/route.repository.port.js';

export class GetRouteUseCase {
  constructor(private readonly repository: RouteRepository) {}

  async execute(rawId: unknown): Promise<RouteDetail> {
    const id = validateUuid(rawId, 'id');
    const record = await this.repository.findDetail(id);
    if (!record) throw new RouteNotFoundError();
    return RoutePlanning.detail(record.route, record.stops);
  }
}

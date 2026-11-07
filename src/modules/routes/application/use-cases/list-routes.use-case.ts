import { RoutePlanning, type RouteListPage } from '../../domain/route.entity.js';
import type { RouteRepository } from '../ports/route.repository.port.js';

export interface ListRoutesInput {
  readonly serviceDate?: string;
  readonly zoneId?: string;
  readonly limit?: string;
  readonly offset?: string;
}

export class ListRoutesUseCase {
  constructor(private readonly repository: RouteRepository) {}

  async execute(input: ListRoutesInput): Promise<RouteListPage> {
    const query = RoutePlanning.prepareListQuery(input);
    const records = await this.repository.list(query);
    return { items: records.map(RoutePlanning.summary), limit: query.limit, offset: query.offset };
  }
}

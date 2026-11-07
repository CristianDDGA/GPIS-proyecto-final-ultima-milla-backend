import { RoutePlanning, type RoutePlanResult } from '../../domain/route.entity.js';
import type { RouteRepository } from '../ports/route.repository.port.js';

export interface PlanRoutesInput {
  readonly serviceDate: unknown;
  readonly capacityLimit: unknown;
  readonly idempotencyKey: unknown;
}

export class PlanRoutesUseCase {
  constructor(private readonly repository: RouteRepository) {}

  async execute(input: PlanRoutesInput): Promise<RoutePlanResult> {
    const command = RoutePlanning.prepare(input);
    const result = await this.repository.generatePlan(command);
    return RoutePlanning.acceptResult(command, result);
  }
}

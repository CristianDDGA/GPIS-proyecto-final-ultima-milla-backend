import { RouteOperations, type LatePlacementResult } from '../../domain/route-operation.entity.js';
import type { LatePlacementRepository } from '../ports/late-placement.repository.port.js';

export interface PlaceLateOrderInput {
  readonly orderId: unknown;
  readonly capacityLimit: unknown;
  readonly idempotencyKey: unknown;
}

export class PlaceLateOrderUseCase {
  constructor(private readonly repository: LatePlacementRepository) {}

  async execute(input: PlaceLateOrderInput): Promise<LatePlacementResult> {
    const command = RouteOperations.prepareLatePlacement(input);
    const { placement } = await this.repository.placeLateOrder(command);
    return RouteOperations.acceptLatePlacement(command, placement);
  }
}

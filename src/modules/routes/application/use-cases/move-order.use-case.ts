import { RouteOperations, type RouteMoveResult } from '../../domain/route-operation.entity.js';
import type { RouteOperationsRepository } from '../ports/route-operations.repository.port.js';

export interface MoveOrderInput {
  readonly orderId: unknown;
  readonly destinationRouteId: unknown;
}

export class MoveOrderUseCase {
  constructor(private readonly repository: RouteOperationsRepository) {}

  async execute(input: MoveOrderInput): Promise<RouteMoveResult> {
    const command = RouteOperations.prepareMove(input);
    const persisted = await this.repository.moveOrder(command);
    return RouteOperations.acceptMove(command, persisted);
  }
}

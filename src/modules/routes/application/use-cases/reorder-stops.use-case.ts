import { RouteOperations, type StopOrderResult } from '../../domain/route-operation.entity.js';
import type { RouteOperationsRepository } from '../ports/route-operations.repository.port.js';

export interface ReorderStopsInput {
  readonly routeId: unknown;
  readonly orderIds: unknown;
}

export class ReorderStopsUseCase {
  constructor(private readonly repository: RouteOperationsRepository) {}

  async execute(input: ReorderStopsInput): Promise<StopOrderResult> {
    const command = RouteOperations.prepareStopOrder(input);
    const persisted = await this.repository.reorderStops(command);
    return RouteOperations.acceptStopOrder(command, persisted);
  }
}

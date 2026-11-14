import { RouteOperations, type CancelRouteResult } from '../../domain/route-operation.entity.js';
import type { RouteOperationsRepository } from '../ports/route-operations.repository.port.js';

export interface CancelRouteInput {
  readonly routeId: unknown;
}

export class CancelRouteUseCase {
  constructor(private readonly repository: RouteOperationsRepository) {}

  async execute(input: CancelRouteInput): Promise<CancelRouteResult> {
    const routeId = RouteOperations.prepareCancel(input);
    await this.repository.cancelRoute(routeId);
    return { routeId, status: 'cancelada' };
  }
}

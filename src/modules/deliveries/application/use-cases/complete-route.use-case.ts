import { validateActorId } from '../../domain/actor.js';
import { DeliveryError } from '../../domain/delivery.errors.js';
import { validateRouteId, type RouteCompletionResult } from '../../domain/delivery-order.js';
import type { ActorContextPort } from '../ports/actor-context.port.js';
import type { DeliveryRepository } from '../ports/delivery.repository.js';

export class CompleteRouteUseCase {
  constructor(
    private readonly repository: Pick<DeliveryRepository, 'completeRoute'>,
    private readonly actorContext: ActorContextPort,
  ) {}

  async execute(rawRouteId: unknown): Promise<RouteCompletionResult> {
    const routeId = validateRouteId(rawRouteId);
    const trustedActor = await this.actorContext.getCurrentActor();
    if (!trustedActor) {
      throw new DeliveryError('FORBIDDEN', 'Actor de contexto no configurado.');
    }
    const actorId = validateActorId(trustedActor.actorId);
    return this.repository.completeRoute(actorId, routeId);
  }
}

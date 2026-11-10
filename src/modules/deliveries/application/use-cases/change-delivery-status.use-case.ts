import { validateActorId } from '../../domain/actor.js';
import { DeliveryError } from '../../domain/delivery.errors.js';
import {
  validateStatusChangeInput,
  type DeliveryStatusChangeResult,
} from '../../domain/delivery-order.js';
import type { ActorContextPort } from '../ports/actor-context.port.js';
import type { DeliveryRepository } from '../ports/delivery.repository.js';

export class ChangeDeliveryStatusUseCase {
  constructor(
    private readonly repository: Pick<DeliveryRepository, 'changeOrderStatus'>,
    private readonly actorContext: ActorContextPort,
  ) {}

  async execute(input: {
    readonly orderId: unknown;
    readonly newStatus: unknown;
    readonly expectedVersion: unknown;
    readonly idempotencyKey: unknown;
  }): Promise<DeliveryStatusChangeResult> {
    const command = validateStatusChangeInput(input);
    const trustedActor = await this.actorContext.getCurrentActor();
    if (!trustedActor) {
      throw new DeliveryError('FORBIDDEN', 'Actor de contexto no configurado.');
    }
    const actorId = validateActorId(trustedActor.actorId);
    return this.repository.changeOrderStatus(actorId, command);
  }
}

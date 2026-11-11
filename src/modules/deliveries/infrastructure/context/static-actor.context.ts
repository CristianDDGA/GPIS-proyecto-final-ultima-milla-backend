import type { ActorContextPort } from '../../application/ports/actor-context.port.js';
import type { TrustedActor } from '../../domain/actor.js';

export class StaticActorContext implements ActorContextPort {
  constructor(private readonly actorId: string | null) {}

  getCurrentActor(): TrustedActor | null {
    return this.actorId === null ? null : { actorId: this.actorId };
  }
}

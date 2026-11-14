import { getRequestActor } from '../../../../bootstrap/auth.middleware.js';
import type { ActorContextPort } from '../../application/ports/actor-context.port.js';
import type { TrustedActor } from '../../domain/actor.js';

export class RequestActorContext implements ActorContextPort {
  constructor(private readonly fallback?: ActorContextPort) {}

  getCurrentActor(): Promise<TrustedActor | null> | TrustedActor | null {
    const actor = getRequestActor();
    if (actor) {
      return { actorId: actor.sub };
    }
    return this.fallback?.getCurrentActor() ?? null;
  }
}

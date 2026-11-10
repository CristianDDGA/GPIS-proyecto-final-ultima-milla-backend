import type { TrustedActor } from '../../domain/actor.js';

export interface ActorContextPort {
  getCurrentActor(): Promise<TrustedActor | null> | TrustedActor | null;
}

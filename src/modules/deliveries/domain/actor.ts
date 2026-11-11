import { DeliveryError } from './delivery.errors.js';

export type ActorRole = 'personal' | 'repartidor';

export interface Actor {
  readonly id: string;
  readonly authSubject: string;
  readonly role: ActorRole;
  readonly isActive: boolean;
}

export interface TrustedActor {
  readonly actorId: string;
}

export function validateActorId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new DeliveryError('FORBIDDEN', 'Actor de contexto no válido.');
  }
  return value.toLowerCase();
}

export function isActorRole(value: unknown): value is ActorRole {
  return value === 'personal' || value === 'repartidor';
}

export function assertActorActive(actor: Actor | null | undefined): asserts actor is Actor {
  if (!actor || !actor.isActive || !isActorRole(actor.role)) {
    throw new DeliveryError('FORBIDDEN', 'El actor no existe o no está activo.');
  }
}

export function assertCanCompleteRoute(
  actor: Actor,
  routeCourierUserId: string | null,
  courierEnabled = true,
): void {
  assertActorActive(actor);
  if (actor.role === 'repartidor') {
    if (!courierEnabled || !routeCourierUserId || routeCourierUserId !== actor.id) {
      throw new DeliveryError(
        'FORBIDDEN',
        'El repartidor solo puede completar rutas asignadas a su usuario.',
      );
    }
  }
}

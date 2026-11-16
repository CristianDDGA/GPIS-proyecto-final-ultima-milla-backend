import { createApp } from './create-app.js';
import type { createDatabaseClient } from './database.js';
import { PrismaZoneRepository } from '../modules/zones/infrastructure/postgres/prisma-zone.repository.js';
import { PrismaOrderRepository } from '../modules/orders/infrastructure/postgres/prisma-order.repository.js';
import { logisticaOrderSql } from '../modules/orders/infrastructure/postgres/logistica-order.sql.js';
import { PrismaOrderZoneLookup } from '../modules/orders/infrastructure/postgres/prisma-order-zone.lookup.js';
import { createRoutesModule, createRouteOperationsModule } from '../modules/routes/index.js';
import { PrismaRouteRepository } from '../modules/routes/infrastructure/postgres/prisma-route.repository.js';
import { PrismaRouteOperationsRepository } from '../modules/routes/infrastructure/postgres/prisma-route-operations.repository.js';
import { createCouriersModule } from '../modules/couriers/index.js';
import { PrismaCourierRepository } from '../modules/couriers/infrastructure/postgres/prisma-courier.repository.js';
import { PrismaAssignmentRepository } from '../modules/couriers/infrastructure/postgres/prisma-assignment.repository.js';
import { createDeliveriesModule } from '../modules/deliveries/index.js';
import { PrismaDeliveryRepository } from '../modules/deliveries/infrastructure/postgres/prisma-delivery.repository.js';
import { StaticActorContext } from '../modules/deliveries/infrastructure/context/static-actor.context.js';
import { RequestActorContext } from '../modules/deliveries/infrastructure/context/request-actor.context.js';
import type { ActorContextPort } from '../modules/deliveries/application/ports/actor-context.port.js';
import { createAuthModule } from '../modules/auth/index.js';
import { PrismaAuthRepository } from '../modules/auth/infrastructure/postgres/prisma-auth.repository.js';
import type { EmailSender } from '../modules/auth/application/ports/email-sender.port.js';
import { PrismaTokenRevocationStore } from '../modules/auth/infrastructure/postgres/prisma-token-revocation.store.js';

export interface PersistedAppOptions {
  readonly actorContext?: ActorContextPort;
  readonly jwtSecret?: string;
  readonly jwtExpiresInSeconds?: number;
  readonly authRateLimit?: { readonly maxRequests: number; readonly windowMs: number };
  readonly trustProxyHops?: number;
  /** Sin valor, los correos se escriben en la consola (solo desarrollo). */
  readonly emailSender?: EmailSender;
  /** Por defecto true; false = modo demo. */
  readonly emailVerificationRequired?: boolean;
}

// Sin secreto de respaldo: un valor fijo en el código permitiría falsificar tokens de administrador.
function requireJwtSecret(value: string | undefined): string {
  if (value === undefined || value.length < 16) {
    throw new Error('createPersistedApp requiere un JWT secret de al menos 16 caracteres (JWT_SECRET).');
  }
  return value;
}

// Single API: zones, orders, routes, couriers, route-operations and deliveries share one server, one database client and one CORS policy.
export function createPersistedApp(
  database: ReturnType<typeof createDatabaseClient>,
  webOrigin: string,
  options?: PersistedAppOptions,
) {
  const routes = createRoutesModule(new PrismaRouteRepository(database));
  const routeOperationsAdapter = new PrismaRouteOperationsRepository(database);
  const routeOperations = createRouteOperationsModule({
    operations: routeOperationsAdapter,
    latePlacements: routeOperationsAdapter,
  });
  const couriers = createCouriersModule({
    couriers: new PrismaCourierRepository(database),
    assignments: new PrismaAssignmentRepository(database),
  });
  const fallbackActorContext =
    options?.actorContext ?? new StaticActorContext(process.env['S3_DELIVERIES_ACTOR_ID'] ?? null);
  const deliveries = createDeliveriesModule({
    repository: new PrismaDeliveryRepository(database),
    actorContext: new RequestActorContext(fallbackActorContext),
  });
  const auth = createAuthModule({
    repository: new PrismaAuthRepository(database),
    revocationStore: new PrismaTokenRevocationStore(database),
    jwtSecret: requireJwtSecret(options?.jwtSecret ?? process.env['JWT_SECRET']),
    ...(options?.jwtExpiresInSeconds !== undefined ? { jwtExpiresInSeconds: options.jwtExpiresInSeconds } : {}),
    ...(options?.emailSender ? { emailSender: options.emailSender } : {}),
    ...(options?.emailVerificationRequired !== undefined ? { emailVerificationRequired: options.emailVerificationRequired } : {}),
  });

  return createApp({
    webOrigin,
    checkDatabase: () => database.$queryRaw`SELECT 1`,
    ...(options?.authRateLimit ? { authRateLimit: options.authRateLimit } : {}),
    ...(options?.trustProxyHops !== undefined ? { trustProxyHops: options.trustProxyHops } : {}),
    tokenService: auth.tokenService,
    tokenRevocationStore: auth.revocationStore,
    zoneRepository: new PrismaZoneRepository(database),
    orderRepository: new PrismaOrderRepository(database, logisticaOrderSql),
    orderZoneLookup: new PrismaOrderZoneLookup(database),
    routers: [
      { basePath: '/auth', router: auth.router },
      ...routes.routers,
      ...routeOperations.routers,
      { basePath: '/', router: couriers.router },
      { basePath: '/', router: deliveries.router },
    ],
    errorHandlers: [
      auth.errorHandler,
      routes.errorHandler,
      routeOperations.errorHandler,
      couriers.errorHandler,
      deliveries.errorHandler,
    ],
  });
}

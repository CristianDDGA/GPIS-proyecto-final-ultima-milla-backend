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
import type { GoogleTokenVerifier } from '../modules/auth/application/ports/google-token-verifier.port.js';
import { GoogleIdTokenVerifier } from '../modules/auth/infrastructure/crypto/google-id-token-verifier.js';
import type { SecurityLog } from '../modules/auth/application/ports/security-log.port.js';
import { PrismaTokenRevocationStore } from '../modules/auth/infrastructure/postgres/prisma-token-revocation.store.js';
import { createCourierApplicationsModule } from '../modules/courier-applications/index.js';
import { PrismaApplicationRepository } from '../modules/courier-applications/infrastructure/postgres/prisma-application.repository.js';
import { DiskFileStorage } from '../modules/courier-applications/infrastructure/storage/disk-file-storage.js';
import type { FileStorage } from '../modules/courier-applications/application/ports/file-storage.port.js';
import { createStoreModule, type NotificationWorker } from '../modules/store/index.js';
import { PrismaFlowsRepository } from '../modules/store/infrastructure/postgres/prisma-flows.repository.js';
import { PrismaStoreRepository } from '../modules/store/infrastructure/postgres/prisma-store.repository.js';
import { ProductImageStorageAdapter } from '../modules/store/infrastructure/storage/product-image-storage.js';
import type { ProductImageStorage } from '../modules/store/application/ports/store.ports.js';

export interface PersistedAppOptions {
  readonly actorContext?: ActorContextPort;
  readonly jwtSecret?: string;
  readonly jwtExpiresInSeconds?: number;
  readonly authRateLimit?: { readonly maxRequests: number; readonly windowMs: number };
  readonly trustProxyHops?: number;
  /** Sin valor, los correos se escriben en la consola (solo desarrollo). */
  readonly emailSender?: EmailSender;
  /** Client ID de Google (público). Con él se habilita POST /auth/google. */
  readonly googleClientId?: string;
  /** Pruebas: verificador ya armado (sustituye al de Google). */
  readonly googleTokenVerifier?: GoogleTokenVerifier;
  /** Recibe el proceso de avisos por correo de la tienda (si hay correo configurado) para que el servidor lo inicie y lo detenga. */
  readonly onNotificationWorker?: (worker: NotificationWorker) => void;
  /** Por defecto true; false = modo demo. */
  readonly emailVerificationRequired?: boolean;
  readonly loginLockout?: { readonly maxFailures: number; readonly lockSeconds: number };
  /** Registro de eventos de seguridad (una línea JSON por evento en server.ts). */
  readonly securityLog?: SecurityLog;
  /** Almacén de las imágenes de las solicitudes de conductor. Por defecto, disco en `uploadsDir`. */
  readonly fileStorage?: FileStorage;
  readonly uploadsDir?: string;
  /** Almacén de las imágenes de los productos. Por defecto, disco en `productUploadsDir`. */
  readonly productImageStorage?: ProductImageStorage;
  readonly productUploadsDir?: string;
  /** Límite de pedidos de tienda por IP. Sin valor: 30 por minuto. */
  readonly storeRateLimit?: { readonly maxRequests: number; readonly windowMs: number };
  /** Pedidos por viaje con los que nace un conductor aprobado. */
  readonly courierDefaultCapacity?: number;
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
  const googleClientId = options?.googleClientId ?? process.env['GOOGLE_CLIENT_ID']?.trim();
  const googleVerifier = options?.googleTokenVerifier ?? (googleClientId ? new GoogleIdTokenVerifier({ clientId: googleClientId }) : undefined);
  const auth = createAuthModule({
    repository: new PrismaAuthRepository(database),
    revocationStore: new PrismaTokenRevocationStore(database),
    jwtSecret: requireJwtSecret(options?.jwtSecret ?? process.env['JWT_SECRET']),
    ...(options?.jwtExpiresInSeconds !== undefined ? { jwtExpiresInSeconds: options.jwtExpiresInSeconds } : {}),
    ...(options?.emailSender ? { emailSender: options.emailSender } : {}),
    ...(options?.loginLockout ? { loginLockout: options.loginLockout } : {}),
    ...(options?.securityLog ? { securityLog: options.securityLog } : {}),
    ...(options?.emailVerificationRequired !== undefined ? { emailVerificationRequired: options.emailVerificationRequired } : {}),
    ...(googleVerifier ? { googleVerifier } : {}),
  });

  const courierApplications = createCourierApplicationsModule({
    repository: new PrismaApplicationRepository(database),
    storage:
      options?.fileStorage ?? new DiskFileStorage(options?.uploadsDir ?? process.env['COURIER_UPLOADS_DIR'] ?? './storage/courier-applications'),
    revocationStore: auth.revocationStore,
    ...(options?.emailSender ? { emailSender: options.emailSender } : {}),
    ...(options?.securityLog ? { securityLog: options.securityLog } : {}),
    ...(options?.courierDefaultCapacity !== undefined ? { defaultCapacity: options.courierDefaultCapacity } : {}),
  });

  const storeRepository = new PrismaStoreRepository(database);
  const store = createStoreModule({
    catalog: storeRepository,
    orders: storeRepository,
    flows: new PrismaFlowsRepository(database),
    ...(options?.emailSender ? { emailSender: options.emailSender } : {}),
    images:
      options?.productImageStorage ??
      new ProductImageStorageAdapter(
        new DiskFileStorage(options?.productUploadsDir ?? process.env['PRODUCT_UPLOADS_DIR'] ?? './storage/product-images'),
      ),
  });

  if (store.notificationWorker) options?.onNotificationWorker?.(store.notificationWorker);

  return createApp({
    webOrigin,
    checkDatabase: () => database.$queryRaw`SELECT 1`,
    ...(options?.authRateLimit ? { authRateLimit: options.authRateLimit } : {}),
    storeRateLimit: options?.storeRateLimit ?? { maxRequests: 30, windowMs: 60_000 },
    ...(options?.trustProxyHops !== undefined ? { trustProxyHops: options.trustProxyHops } : {}),
    tokenService: auth.tokenService,
    tokenRevocationStore: auth.revocationStore,
    zoneRepository: new PrismaZoneRepository(database),
    orderRepository: new PrismaOrderRepository(database, logisticaOrderSql),
    orderZoneLookup: new PrismaOrderZoneLookup(database),
    routers: [
      { basePath: '/auth', router: auth.router },
      { basePath: '/courier-applications', router: courierApplications.router },
      { basePath: '/store', router: store.router },
      ...routes.routers,
      ...routeOperations.routers,
      { basePath: '/', router: couriers.router },
      { basePath: '/', router: deliveries.router },
    ],
    errorHandlers: [
      auth.errorHandler,
      courierApplications.errorHandler,
      store.errorHandler,
      routes.errorHandler,
      routeOperations.errorHandler,
      couriers.errorHandler,
      deliveries.errorHandler,
    ],
  });
}

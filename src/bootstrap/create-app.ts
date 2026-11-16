import express, { type ErrorRequestHandler, type Router } from 'express';
import type { ZoneRepository } from '../modules/zones/application/ports/zone.repository.port.js';
import { createZonesModule } from '../modules/zones/index.js';
import type { OrderRepository } from '../modules/orders/application/ports/order.repository.port.js';
import { createOrdersModule } from '../modules/orders/index.js';
import { fallbackErrorHandler, jsonErrorHandler, notFoundHandler, requireJsonObject } from './json.middleware.js';
import type { OrderZonePort } from '../modules/orders/application/ports/order-zone.port.js';
import type { TokenRevocationStore } from '../modules/auth/application/ports/token-revocation.port.js';
import type { TokenService } from '../modules/auth/application/ports/token-service.port.js';
import { createRbacMiddleware } from './auth.middleware.js';
import { createRateLimiter } from './rate-limit.middleware.js';

export interface AppDependencies {
  readonly webOrigin: string;
  readonly routers?: ReadonlyArray<{ readonly basePath: string; readonly router: Router }>;
  readonly zoneRepository?: ZoneRepository;
  readonly orderRepository?: OrderRepository;
  readonly orderZoneLookup?: OrderZonePort;
  readonly errorHandlers?: ReadonlyArray<ErrorRequestHandler>;
  readonly tokenService?: TokenService;
  readonly tokenRevocationStore?: TokenRevocationStore;
  /** Debe rechazar si PostgreSQL no responde; /health devuelve 503 en ese caso. */
  /** Límite de intentos por IP en /auth/login y /auth/register; sin valor, no se limita. */
  readonly authRateLimit?: { readonly maxRequests: number; readonly windowMs: number; readonly now?: () => number };
  readonly checkDatabase?: () => Promise<unknown>;
}

const HEALTH_DB_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('health check timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createApp(dependencies: AppDependencies) {
  const app = express();

  app.disable('x-powered-by');
  // Hallazgo ZAP 10021: impide el MIME sniffing de las respuestas JSON.
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Hallazgo ZAP 10049: las respuestas de la API no deben almacenarse en caché.
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use((request, response, next) => {
    const origin = request.get('origin');
    const originAllowed = origin === dependencies.webOrigin;

    if (originAllowed) {
      response.setHeader('Access-Control-Allow-Origin', dependencies.webOrigin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
    }

    if (request.method === 'OPTIONS') {
      response.sendStatus(originAllowed ? 204 : 403);
      return;
    }

    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(requireJsonObject);
  if (dependencies.authRateLimit) {
    app.use(createRateLimiter({ ...dependencies.authRateLimit, paths: ['/auth/login', '/auth/register'] }));
  }
  app.get('/health', async (_request, response) => {
    if (dependencies.checkDatabase) {
      try {
        await withTimeout(dependencies.checkDatabase(), HEALTH_DB_TIMEOUT_MS);
      } catch {
        const code = 'SERVICE_UNAVAILABLE';
        const message = 'PostgreSQL no disponible.';
        response.status(503).json({ code, message, error: { code, message } });
        return;
      }
    }
    response.status(200).json({ status: 'ok' });
  });

  if (dependencies.tokenService) {
    app.use(createRbacMiddleware(dependencies.tokenService, dependencies.tokenRevocationStore));
  }

  const routers = [...(dependencies.routers ?? [])];
  if (dependencies.zoneRepository) {
    const zonesModule = createZonesModule(dependencies.zoneRepository);
    routers.push({ basePath: '/zones', router: zonesModule.router });
  }

  if (dependencies.orderRepository) {
    const zoneLookup = dependencies.orderZoneLookup ?? dependencies.zoneRepository;
    if (!zoneLookup) throw new Error('Orders requiere un puerto de consulta de zonas.');
    const ordersModule = createOrdersModule({
      orderRepository: dependencies.orderRepository,
      zoneRepository: zoneLookup,
    });
    routers.push({ basePath: '/orders', router: ordersModule.router });
  }

  for (const { basePath, router } of routers) {
    app.use(basePath, router);
  }

  // Module handlers only answer their own paths; the shared handler covers every other JSON error.
  for (const handler of dependencies.errorHandlers ?? []) app.use(handler);
  app.use(jsonErrorHandler);
  // Unknown paths and unexpected failures always answer with the shared JSON envelope.
  app.use(notFoundHandler);
  app.use(fallbackErrorHandler);

  return app;
}

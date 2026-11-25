import express, { type ErrorRequestHandler, type Router } from 'express';
import type { ZoneRepository } from '../modules/zones/application/ports/zone.repository.port.js';
import { createZonesModule, ZoneDeliveryGuardService } from '../modules/zones/index.js';
import type { OrderRepository } from '../modules/orders/application/ports/order.repository.port.js';
import { createOrdersModule } from '../modules/orders/index.js';
import { orderZonePortFrom } from '../modules/orders/infrastructure/zone-repository.lookup.js';
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
  /** Límite de pedidos de tienda por IP (POST /store/orders); sin valor, no se limita. */
  readonly storeRateLimit?: { readonly maxRequests: number; readonly windowMs: number; readonly now?: () => number };
  /** Saltos de proxy confiables (X-Forwarded-For). Sin valor, se usa la IP del socket. */
  readonly trustProxyHops?: number;
  readonly checkDatabase?: () => Promise<unknown>;
}

const HEALTH_DB_TIMEOUT_MS = 2_000;

// Endpoints públicos de cuentas: cada uno cuenta aparte por IP. Los que envían correo o prueban códigos
// quedan limitados para que no sirvan de relevo de spam ni de fuerza bruta.
const AUTH_RATE_LIMITED_PATHS = [
  '/auth/login',
  '/auth/google',
  '/auth/register',
  '/auth/verify-email',
  '/auth/resend-verification',
  '/auth/forgot-password',
  '/auth/reset-password',
];

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
  // Detrás de un proxy/balanceador, sin esto todos los clientes comparten la IP del proxy y el
  // rate limiter los bloquearía juntos. Solo se activa si se configura explícitamente.
  if (dependencies.trustProxyHops !== undefined) app.set('trust proxy', dependencies.trustProxyHops);
  // Hallazgo ZAP 10021: impide el MIME sniffing de las respuestas JSON.
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Hallazgo ZAP 10049: las respuestas de la API no deben almacenarse en caché.
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  const allowedOrigins = allowedWebOrigins(dependencies.webOrigin);
  app.use((request, response, next) => {
    const origin = request.get('origin');
    const originAllowed = origin !== undefined && allowedOrigins.has(origin);

    if (originAllowed) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
      // El navegador solo deja leer estas cabeceras de respuesta si se exponen: el pedido repetido y la espera sugerida.
      response.setHeader('Access-Control-Expose-Headers', 'Idempotent-Replayed,Retry-After');
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
    app.use(createRateLimiter({ ...dependencies.authRateLimit, paths: AUTH_RATE_LIMITED_PATHS }));
  }
  if (dependencies.storeRateLimit) {
    app.use(createRateLimiter({ ...dependencies.storeRateLimit, paths: ['/store/orders'] }));
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
    const zoneLookup = dependencies.orderZoneLookup ?? (dependencies.zoneRepository ? orderZonePortFrom(dependencies.zoneRepository) : undefined);
    if (!zoneLookup) throw new Error('Orders requiere un puerto de consulta de zonas.');
    const ordersModule = createOrdersModule({
      orderRepository: dependencies.orderRepository,
      zoneRepository: zoneLookup,
      ...(dependencies.zoneRepository ? { zoneGuard: new ZoneDeliveryGuardService(dependencies.zoneRepository) } : {}),
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

const LOOPBACK_TWINS: Readonly<Record<string, string>> = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' };

/**
 * Orígenes aceptados por CORS: WEB_ORIGIN y, solo en desarrollo local, su gemelo de loopback
 * (localhost <-> 127.0.0.1, mismo protocolo y puerto), porque el navegador los trata como sitios distintos.
 */
export function allowedWebOrigins(webOrigin: string): ReadonlySet<string> {
  const origins = new Set([webOrigin]);
  const parsed = new URL(webOrigin);
  const twin = LOOPBACK_TWINS[parsed.hostname];
  if (twin !== undefined) {
    parsed.hostname = twin;
    origins.add(parsed.origin);
  }
  return origins;
}

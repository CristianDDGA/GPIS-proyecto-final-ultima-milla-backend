import express, { type ErrorRequestHandler, type Router } from 'express';
import type { ZoneRepository } from '../modules/zones/application/ports/zone.repository.port.js';
import { createZonesModule } from '../modules/zones/index.js';
import type { OrderRepository } from '../modules/orders/application/ports/order.repository.port.js';
import { createOrdersModule } from '../modules/orders/index.js';
import { fallbackErrorHandler, jsonErrorHandler, notFoundHandler, requireJsonObject } from './json.middleware.js';
import type { OrderZonePort } from '../modules/orders/application/ports/order-zone.port.js';

export interface AppDependencies {
  readonly webOrigin: string;
  readonly routers?: ReadonlyArray<{ readonly basePath: string; readonly router: Router }>;
  readonly zoneRepository?: ZoneRepository;
  readonly orderRepository?: OrderRepository;
  readonly orderZoneLookup?: OrderZonePort;
  readonly errorHandlers?: ReadonlyArray<ErrorRequestHandler>;
}

export function createApp(dependencies: AppDependencies) {
  const app = express();

  app.disable('x-powered-by');
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
  app.get('/health', (_request, response) => response.status(200).json({ status: 'ok' }));

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

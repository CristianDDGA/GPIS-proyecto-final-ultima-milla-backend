import { createApp } from './create-app.js';
import type { createDatabaseClient } from './database.js';
import { PrismaZoneRepository } from '../modules/zones/infrastructure/postgres/prisma-zone.repository.js';
import { PrismaOrderRepository } from '../modules/orders/infrastructure/postgres/prisma-order.repository.js';
import { logisticaOrderSql } from '../modules/orders/infrastructure/postgres/logistica-order.sql.js';
import { PrismaOrderZoneLookup } from '../modules/orders/infrastructure/postgres/prisma-order-zone.lookup.js';
import { createRoutesModule } from '../modules/routes/index.js';
import { PrismaRouteRepository } from '../modules/routes/infrastructure/postgres/prisma-route.repository.js';
import { createCouriersModule } from '../modules/couriers/index.js';
import { PrismaCourierRepository } from '../modules/couriers/infrastructure/postgres/prisma-courier.repository.js';
import { PrismaAssignmentRepository } from '../modules/couriers/infrastructure/postgres/prisma-assignment.repository.js';

// Single API: zones, orders, routes and couriers share one server, one database client and one CORS policy.
export function createPersistedApp(database: ReturnType<typeof createDatabaseClient>, webOrigin: string) {
  const routes = createRoutesModule(new PrismaRouteRepository(database));
  const couriers = createCouriersModule({
    couriers: new PrismaCourierRepository(database),
    assignments: new PrismaAssignmentRepository(database),
  });
  return createApp({
    webOrigin,
    zoneRepository: new PrismaZoneRepository(database),
    orderRepository: new PrismaOrderRepository(database, logisticaOrderSql),
    orderZoneLookup: new PrismaOrderZoneLookup(database),
    routers: [...routes.routers, { basePath: '/', router: couriers.router }],
    errorHandlers: [routes.errorHandler, couriers.errorHandler],
  });
}

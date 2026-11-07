import { createApp } from './create-app.js';
import type { createDatabaseClient } from './database.js';
import { PrismaZoneRepository } from '../modules/zones/infrastructure/postgres/prisma-zone.repository.js';
import { PrismaOrderRepository } from '../modules/orders/infrastructure/postgres/prisma-order.repository.js';
import { logisticaOrderSql } from '../modules/orders/infrastructure/postgres/logistica-order.sql.js';
import { PrismaOrderZoneLookup } from '../modules/orders/infrastructure/postgres/prisma-order-zone.lookup.js';

export function createPersistedApp(database: ReturnType<typeof createDatabaseClient>, webOrigin: string) {
  return createApp({ webOrigin,
    zoneRepository: new PrismaZoneRepository(database),
    orderRepository: new PrismaOrderRepository(database, logisticaOrderSql),
    orderZoneLookup: new PrismaOrderZoneLookup(database),
  });
}

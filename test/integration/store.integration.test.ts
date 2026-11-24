import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/bootstrap/create-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { InMemoryFileStorage } from '../../src/modules/courier-applications/infrastructure/storage/in-memory-file-storage.js';
import { createStoreModule } from '../../src/modules/store/index.js';
import { InMemoryStoreRepository } from '../../src/modules/store/infrastructure/in-memory/in-memory-store.repository.js';
import { ProductImageStorageAdapter } from '../../src/modules/store/infrastructure/storage/product-image-storage.js';
import { defineStoreApiSuite, TEST_COVERAGE, type StoreHarness, type StoreHarnessOptions } from '../support/store-api-suite.js';
import { Zone } from '../../src/modules/zones/domain/zone.entity.js';
import { ZoneDeliveryGuardService } from '../../src/modules/zones/application/zone-delivery-guard.service.js';
import { defineStoreCoordinatesSuite, defineStoreFlowsSuite } from '../support/store-flows-suite.js';

const SECRET = 'store-integration-secret-key-12345';
const ORIGIN = 'http://127.0.0.1:5173';

function memoryHarness(options?: StoreHarnessOptions): StoreHarness {
  const zoneId = randomUUID();
  const uncoveredZoneId = randomUUID();
  const inactiveZoneId = randomUUID();
  const driverUserId = randomUUID();
  // La misma regla que en producción (ZoneDeliveryGuardService), sobre zonas de prueba: una con cobertura y otra sin ella.
  const now = new Date();
  const zones = new Map<string, Zone>([
    [zoneId, Zone.create({ id: zoneId, name: 'Zona de tienda', createdAt: now, updatedAt: now, coverage: TEST_COVERAGE })],
    [uncoveredZoneId, Zone.create({ id: uncoveredZoneId, name: 'Zona sin cobertura', createdAt: now, updatedAt: now, coverage: null })],
  ]);
  const zoneGuard = new ZoneDeliveryGuardService({ findById: async (id) => zones.get(id) ?? null });
  const repository = new InMemoryStoreRepository({
    zoneState: (id) => (id === zoneId || id === uncoveredZoneId ? 'active' : id === inactiveZoneId ? 'inactive' : 'missing'),
    // Mismo nombre que el conductor de la suite de PostgreSQL.
    courierName: (id) => (id === driverUserId ? 'Conductor de tienda' : null),
  });
  const images = new InMemoryFileStorage();
  const store = createStoreModule({ catalog: repository, orders: repository, flows: repository, zoneGuard, images: new ProductImageStorageAdapter(images) });
  const tokens = new HmacJwtTokenService(SECRET);
  const token = (role: 'personal' | 'cliente' | 'repartidor', sub: string = randomUUID()) =>
    tokens.sign({ sub, role, authSubject: `${role}@test`, courierId: null });
  repository.registerCourier(driverUserId);
  const app = createApp({
    webOrigin: ORIGIN,
    tokenService: tokens,
    routers: [{ basePath: '/store', router: store.router }],
    errorHandlers: [store.errorHandler],
    ...(options?.storeRateLimit ? { storeRateLimit: options.storeRateLimit } : {}),
  });
  return {
    app,
    driverUserId,
    dispatch: {
      assign: async (orderIds) => repository.assignToRoute(orderIds, driverUserId),
      advance: async (orderId, to) => repository.advance(orderId, to),
      closeRoute: async (routeId) => repository.closeRoute(routeId),
    },
    notificationKinds: async (orderId) => repository.notificationKinds(orderId),
    adminToken: token('personal'),
    customerToken: token('cliente'),
    otherCustomerToken: token('cliente'),
    driverToken: token('repartidor', driverUserId),
    zoneId,
    uncoveredZoneId,
    inactiveZoneId,
    missingZoneId: randomUUID(),
    pin: { latitude: TEST_COVERAGE.latitude, longitude: TEST_COVERAGE.longitude },
    images,
  };
}

describe('Tienda · API HTTP con repositorio en memoria', () => {
  defineStoreApiSuite(memoryHarness);
});

describe('Flujos por rol · API HTTP con repositorio en memoria', () => {
  defineStoreFlowsSuite(() => memoryHarness());
});

describe('Mapa y coordenadas · API HTTP con repositorio en memoria', () => {
  defineStoreCoordinatesSuite(() => memoryHarness());
});

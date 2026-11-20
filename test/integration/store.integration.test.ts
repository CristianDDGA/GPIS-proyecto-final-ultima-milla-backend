import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/bootstrap/create-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { InMemoryFileStorage } from '../../src/modules/courier-applications/infrastructure/storage/in-memory-file-storage.js';
import { createStoreModule } from '../../src/modules/store/index.js';
import { InMemoryStoreRepository } from '../../src/modules/store/infrastructure/in-memory/in-memory-store.repository.js';
import { ProductImageStorageAdapter } from '../../src/modules/store/infrastructure/storage/product-image-storage.js';
import { defineStoreApiSuite, type StoreHarness, type StoreHarnessOptions } from '../support/store-api-suite.js';
import { defineStoreCoordinatesSuite, defineStoreFlowsSuite } from '../support/store-flows-suite.js';

const SECRET = 'store-integration-secret-key-12345';
const ORIGIN = 'http://127.0.0.1:5173';

function memoryHarness(options?: StoreHarnessOptions): StoreHarness {
  const zoneId = randomUUID();
  const inactiveZoneId = randomUUID();
  const repository = new InMemoryStoreRepository({
    zoneState: (id) => (id === zoneId ? 'active' : id === inactiveZoneId ? 'inactive' : 'missing'),
  });
  const images = new InMemoryFileStorage();
  const store = createStoreModule({ catalog: repository, orders: repository, flows: repository, images: new ProductImageStorageAdapter(images) });
  const tokens = new HmacJwtTokenService(SECRET);
  const token = (role: 'personal' | 'cliente' | 'repartidor', sub: string = randomUUID()) =>
    tokens.sign({ sub, role, authSubject: `${role}@test`, courierId: null });
  const driverUserId = randomUUID();
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
    inactiveZoneId,
    missingZoneId: randomUUID(),
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

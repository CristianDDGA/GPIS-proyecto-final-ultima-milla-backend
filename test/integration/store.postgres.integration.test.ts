import { randomUUID } from 'node:crypto';
import { createPersistedApp } from '../../src/bootstrap/create-persisted-app.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';
import { InMemoryFileStorage } from '../../src/modules/courier-applications/infrastructure/storage/in-memory-file-storage.js';
import { ProductImageStorageAdapter } from '../../src/modules/store/infrastructure/storage/product-image-storage.js';
import { defineStoreApiSuite, type StoreHarness, type StoreHarnessOptions } from '../support/store-api-suite.js';
import { realDatabase } from './database.fixture.js';
import { deliveryDatabase, resetTestData, runAdminSql } from './sprint03/deliveries.fixture.js';

// La MISMA suite HTTP de la tienda, ahora contra PostgreSQL real con la migración 010: las reglas viven en las
// funciones SQL, así que aquí se comprueba que la base de datos y la API responden igual que el repositorio en memoria.

const SECRET = 'store-integration-secret-key-12345';
const ORIGIN = 'http://127.0.0.1:5173';

const describeReal = realDatabase ? describe : describe.skip;

describeReal('Tienda · API HTTP contra PostgreSQL real (migración 010)', () => {
  let database: ReturnType<typeof deliveryDatabase>;
  beforeAll(() => { database = deliveryDatabase(); });
  afterAll(async () => { await database?.$disconnect(); });

  defineStoreApiSuite((options?: StoreHarnessOptions): StoreHarness => {
    resetTestData();
    const admin = randomUUID();
    const customer = randomUUID();
    const otherCustomer = randomUUID();
    const driver = randomUUID();
    const zone = randomUUID();
    const inactiveZone = randomUUID();
    // Un solo viaje a la base: vacía la tienda, restablece la configuración y crea usuarios y zonas con ids conocidos.
    runAdminSql(`
      TRUNCATE logistica.categories CASCADE;
      UPDATE logistica.store_settings SET slot_capacity = 10, first_slot_hour = 8, last_slot_hour = 20, min_lead_minutes = 60;
      INSERT INTO logistica.app_users(id, auth_subject, role) VALUES
        ('${admin}', 'store-admin-${admin}', 'personal'),
        ('${customer}', 'store-customer-${customer}', 'cliente'),
        ('${otherCustomer}', 'store-customer-${otherCustomer}', 'cliente'),
        ('${driver}', 'store-driver-${driver}', 'repartidor');
      INSERT INTO logistica.zones(id, name, is_active) VALUES
        ('${zone}', 'Zona de tienda', true),
        ('${inactiveZone}', 'Zona inactiva de tienda', false);`);

    const images = new InMemoryFileStorage();
    const tokens = new HmacJwtTokenService(SECRET);
    const token = (sub: string, role: 'personal' | 'cliente' | 'repartidor') =>
      tokens.sign({ sub, role, authSubject: `${role}-${sub}`, courierId: null });
    const app = createPersistedApp(database, ORIGIN, {
      jwtSecret: SECRET,
      emailVerificationRequired: false,
      fileStorage: new InMemoryFileStorage(),
      productImageStorage: new ProductImageStorageAdapter(images),
      ...(options?.storeRateLimit ? { storeRateLimit: options.storeRateLimit } : {}),
    });
    return {
      app,
      adminToken: token(admin, 'personal'),
      customerToken: token(customer, 'cliente'),
      otherCustomerToken: token(otherCustomer, 'cliente'),
      driverToken: token(driver, 'repartidor'),
      zoneId: zone,
      inactiveZoneId: inactiveZone,
      missingZoneId: randomUUID(),
      images,
    };
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/bootstrap/config.js';
import { createStorages } from '../../src/bootstrap/storage.js';

const SECRET = 'a'.repeat(16) + 'B'.repeat(16);
const SERVICE_KEY = 'service-role-key-secreta-de-prueba-0123456789';
const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ JWT_SECRET: SECRET, ...overrides }) as NodeJS.ProcessEnv;
const supabaseEnv = (overrides: Record<string, string | undefined> = {}) =>
  env({ STORAGE_DRIVER: 'supabase', SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...overrides });

test('por defecto el almacenamiento es disco (el comportamiento de siempre)', () => {
  const config = loadConfig(env());
  assert.deepEqual(config.storage, { driver: 'disk' });
  assert.equal(config.courierUploadsDir, './storage/courier-applications');
  assert.equal(config.productUploadsDir, './storage/product-images');
  assert.equal(loadConfig(env({ PRODUCT_UPLOADS_DIR: '/data/productos' })).productUploadsDir, '/data/productos');
});

test('STORAGE_DRIVER=supabase exige URL y clave de servicio, con buckets por defecto', () => {
  const config = loadConfig(supabaseEnv());
  assert.deepEqual(config.storage, {
    driver: 'supabase',
    supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
    serviceRoleKey: SERVICE_KEY,
    productBucket: 'product-images',
    courierBucket: 'courier-applications',
  });
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_URL: undefined })), /SUPABASE_URL es obligatoria/);
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined })), /SUPABASE_SERVICE_ROLE_KEY es obligatoria/);
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_SERVICE_ROLE_KEY: 'corta' })), /SUPABASE_SERVICE_ROLE_KEY es obligatoria/);
});

test('un valor de STORAGE_DRIVER desconocido falla al arrancar', () => {
  assert.throws(() => loadConfig(env({ STORAGE_DRIVER: 's3' })), /disk o supabase/);
});

test('la URL de Supabase debe ser https y solo el origen del proyecto', () => {
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_URL: 'http://abcdefghijklmnop.supabase.co' })), /https/);
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co/storage/v1' })), /solo el origen/);
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_URL: 'https://usuario:clave@abcdefghijklmnop.supabase.co' })), /solo el origen/);
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_URL: 'https://abc.supabase.co?x=1' })), /solo el origen/);
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_URL: 'no-es-url' })), /URL válida/);
  assert.equal(loadConfig(supabaseEnv({ SUPABASE_URL: 'http://127.0.0.1:54321' })).storage.driver, 'supabase');
});

test('los buckets deben tener nombres válidos y ser distintos (las fotos de conductores son privadas)', () => {
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_PRODUCT_BUCKET: 'Mayusculas' })), /nombres de bucket/);
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_COURIER_BUCKET: '../x' })), /nombres de bucket/);
  assert.throws(() => loadConfig(supabaseEnv({ SUPABASE_PRODUCT_BUCKET: 'mismo', SUPABASE_COURIER_BUCKET: 'mismo' })), /distintos/);
  const config = loadConfig(supabaseEnv({ SUPABASE_PRODUCT_BUCKET: 'catalogo', SUPABASE_COURIER_BUCKET: 'conductores' }));
  assert.ok(config.storage.driver === 'supabase' && config.storage.productBucket === 'catalogo' && config.storage.courierBucket === 'conductores');
});

test('el mensaje de error de configuración nunca incluye la clave de servicio', () => {
  for (const overrides of [{ SUPABASE_URL: 'http://abc.supabase.co' }, { SUPABASE_PRODUCT_BUCKET: 'Mal Nombre' }, { SUPABASE_COURIER_BUCKET: 'catalogo', SUPABASE_PRODUCT_BUCKET: 'catalogo' }]) {
    try {
      loadConfig(supabaseEnv(overrides));
      assert.fail('debía fallar');
    } catch (error) {
      assert.equal((error as Error).message.includes(SERVICE_KEY), false);
    }
  }
});

test('createStorages: con disco las imágenes de producto se sirven por la API; con Supabase, por URL pública', () => {
  const disk = createStorages(loadConfig(env()));
  const key = `${'a1'.repeat(16)}.png`;
  assert.equal(disk.productImages.publicUrl(key), null);

  const cloud = createStorages(loadConfig(supabaseEnv()));
  assert.equal(cloud.productImages.publicUrl(key), `https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-images/${key}`);
});

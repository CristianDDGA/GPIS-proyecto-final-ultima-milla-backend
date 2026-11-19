import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoreError } from '../../src/modules/store/domain/store.errors.js';
import {
  isIsoDate,
  parseCategoryPatch,
  parseDeliverySlotsQuery,
  parseIdempotencyKey,
  parseNewProduct,
  parsePlaceOrder,
  parseProductFilter,
  parseProductPatch,
  parseSettings,
  parseStockAdjustment,
  validateImageKey,
} from '../../src/modules/store/domain/store.validation.js';
import { isRetryableSqlError, mapStoreSqlError } from '../../src/modules/store/infrastructure/postgres/store-sql-errors.js';

const UUID = '3f2b8c1e-5d4a-4b7e-9c10-0a1b2c3d4e5f';
const KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

function rejects(action: () => unknown, pattern?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof StoreError, 'debe ser un StoreError');
    assert.equal(error.code, 'VALIDATION_ERROR');
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const baseOrder = () => ({
  zoneId: UUID, deliveryAddress: 'Av. 9 de Octubre 123', deliveryDate: '2030-05-10', deliveryTime: '14:00',
  items: [{ productId: UUID, quantity: 2, unitPriceCents: 6999 }],
});

test('isIsoDate acepta fechas reales y rechaza las imposibles', () => {
  for (const ok of ['2030-05-10', '2028-02-29', '2026-12-31']) assert.equal(isIsoDate(ok), true, ok);
  for (const bad of ['2026-02-31', '2027-02-29', '2026-13-01', '2026-00-10', '10/05/2030', '2030-5-1', '', '2030-05-10T00:00']) assert.equal(isIsoDate(bad), false, bad);
});

test('parsePlaceOrder normaliza un pedido válido', () => {
  const command = parsePlaceOrder({ ...baseOrder(), recipientPhone: '+593 99-123 4567', recipientName: '  María   José ', notes: 'Tocar   el timbre.' }, KEY.toUpperCase(), UUID);
  assert.equal(command.idempotencyKey, KEY);
  assert.equal(command.recipientPhone, '+593991234567');
  assert.equal(command.recipientName, 'María José');
  assert.equal(command.notes, 'Tocar el timbre.');
  assert.equal(command.customerId, UUID);
  assert.equal(command.items.length, 1);
});

test('parsePlaceOrder rechaza claves de idempotencia ausentes o que no son UUID', () => {
  for (const key of [undefined, '', 'abc', 123, null, `${KEY}x`]) rejects(() => parsePlaceOrder(baseOrder(), key, UUID), /Idempotency-Key/);
  assert.equal(parseIdempotencyKey(`  ${KEY}  `), KEY);
});

test('parsePlaceOrder rechaza campos extra, líneas inválidas y valores fuera de rango', () => {
  rejects(() => parsePlaceOrder({ ...baseOrder(), totalCents: 1 }, KEY, UUID), /no está permitido/);
  rejects(() => parsePlaceOrder({ ...baseOrder(), __proto__x: 1 } as never, KEY, UUID), /no está permitido/);
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: [] }, KEY, UUID), /al menos un producto/);
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: 'x' }, KEY, UUID), /lista/);
  const line = { productId: UUID, quantity: 1, unitPriceCents: 100 };
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: [line, line] }, KEY, UUID), /repetirse/);
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: [{ ...line, quantity: 11 }] }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: [{ ...line, quantity: 0 }] }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: [{ ...line, unitPriceCents: -5 }] }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: [{ ...line, unitPriceCents: Number.MAX_SAFE_INTEGER }] }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: [{ ...line, unitPriceCents: Number.NaN }] }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: [{ ...line, unitPriceCents: Number.POSITIVE_INFINITY }] }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...baseOrder(), items: Array.from({ length: 21 }, (_u, i) => ({ ...line, productId: `3f2b8c1e-5d4a-4b7e-9c10-0a1b2c3d4e${String(i).padStart(2, '0')}` })) }, KEY, UUID), /más de 20/);
});

test('parsePlaceOrder valida dirección, fecha y hora en punto', () => {
  rejects(() => parsePlaceOrder({ ...baseOrder(), deliveryAddress: 'Calle \u{1F6B2}' }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...baseOrder(), deliveryAddress: 'Calle 1️⃣ y Av. 5' }, KEY, UUID));
  rejects(() => parsePlaceOrder({ ...baseOrder(), deliveryDate: '2030-02-31' }, KEY, UUID), /fecha/);
  for (const time of ['14:30', '14:00:00', '24:00', '9:00', '14:60', '']) rejects(() => parsePlaceOrder({ ...baseOrder(), deliveryTime: time }, KEY, UUID), /hora/);
  rejects(() => parsePlaceOrder({ ...baseOrder(), recipientPhone: '12ab' }, KEY, UUID), /teléfono/);
  rejects(() => parsePlaceOrder({ ...baseOrder(), notes: 'x'.repeat(301) }, KEY, UUID), /300/);
});

test('parseNewProduct no admite la imagen ni campos desconocidos y normaliza el SKU', () => {
  const product = parseNewProduct({ sku: 'aud-100', name: 'Audífonos 100', categoryId: UUID, priceCents: 1000, stock: 3 });
  assert.deepEqual(product, {
    sku: 'AUD-100', name: 'Audífonos 100', brand: null, description: null, categoryId: UUID, priceCents: 1000,
    compareAtPriceCents: null, stock: 3, imageKey: null, isActive: true,
  });
  rejects(() => parseNewProduct({ sku: 'AUD-100', name: 'Audífonos 100', categoryId: UUID, priceCents: 1000, stock: 3, imageKey: `${'a'.repeat(32)}.png` }), /no está permitido/);
  rejects(() => parseNewProduct({ sku: 'AUD-100', name: 'Audífonos 100', categoryId: UUID, priceCents: 1000, stock: 3, createdBy: UUID }), /no está permitido/);
  rejects(() => parseNewProduct({ name: 'Audífonos 100', categoryId: UUID, priceCents: 1000, stock: 3 }), /SKU/);
  rejects(() => parseNewProduct({ sku: 'AUD-100', name: 'Audífonos 100', categoryId: UUID, stock: 3 }), /precio/);
  rejects(() => parseNewProduct({ sku: 'AUD-100', name: 'Audífonos 100', categoryId: UUID, priceCents: 1000 }), /stock/i);
  rejects(() => parseNewProduct({ sku: 'AUD-100', name: 'Audífonos 100', categoryId: UUID, priceCents: 1000, stock: 1_000_001 }));
  rejects(() => parseNewProduct({ sku: 'AUD-100', name: 'Audífonos 100', categoryId: UUID, priceCents: 1000, stock: 3, compareAtPriceCents: 1000 }), /mayor/);
});

test('parseNewProduct trata marca y descripción vacías como ausentes y valida las que vienen', () => {
  const product = parseNewProduct({ sku: 'AUD-100', name: 'Audífonos 100', categoryId: UUID, priceCents: 1000, stock: 3, brand: '  ', description: null });
  assert.equal(product.brand, null);
  assert.equal(product.description, null);
  rejects(() => parseNewProduct({ sku: 'AUD-100', name: 'Audífonos 100', categoryId: UUID, priceCents: 1000, stock: 3, brand: 'Marca \u{1F525}' }));
});

test('parseProductPatch exige la versión y al menos un cambio', () => {
  assert.deepEqual(parseProductPatch({ expectedVersion: 3, priceCents: 500, brand: null }), { expectedVersion: 3, patch: { priceCents: 500, brand: null } });
  rejects(() => parseProductPatch({ priceCents: 500 }), /expectedVersion/);
  rejects(() => parseProductPatch({ expectedVersion: 1 }), /cambios/);
  rejects(() => parseProductPatch({ expectedVersion: 0, priceCents: 5 }));
  rejects(() => parseProductPatch({ expectedVersion: '1', priceCents: 5 }));
  rejects(() => parseProductPatch({ expectedVersion: 1, sku: 'X-1' }), /no está permitido/);
  rejects(() => parseProductPatch({ expectedVersion: 1, stockQuantity: 5 }), /no está permitido/);
  rejects(() => parseProductPatch({ expectedVersion: 1, imageKey: 'x' }), /no está permitido/);
  rejects(() => parseProductPatch({ expectedVersion: 1, priceCents: 500, compareAtPriceCents: 500 }), /mayor/);
  rejects(() => parseProductPatch({ expectedVersion: 1, isActive: 'true' }));
});

test('parseCategoryPatch, parseStockAdjustment y parseSettings validan rangos', () => {
  assert.deepEqual(parseCategoryPatch({ expectedVersion: 1, name: 'Hogar y cocina' }), { name: 'Hogar y cocina', expectedVersion: 1 });
  rejects(() => parseCategoryPatch({ expectedVersion: 1 }), /cambios/);
  assert.deepEqual(parseStockAdjustment({ delta: -3, reason: 'damage' }), { delta: -3, reason: 'damage' });
  for (const body of [{ delta: 0, reason: 'restock' }, { delta: 1.5, reason: 'restock' }, { delta: 100_001, reason: 'restock' }, { delta: 1, reason: 'sale' }, { delta: 1 }, { reason: 'restock' }, { delta: 1, reason: 'restock', extra: 1 }]) {
    rejects(() => parseStockAdjustment(body as never));
  }
  assert.deepEqual(parseSettings({ slotCapacity: 5, firstSlotHour: 8, lastSlotHour: 20, minLeadMinutes: 60 }), { slotCapacity: 5, firstSlotHour: 8, lastSlotHour: 20, minLeadMinutes: 60 });
  rejects(() => parseSettings({ slotCapacity: 501, firstSlotHour: 8, lastSlotHour: 20, minLeadMinutes: 60 }));
  rejects(() => parseSettings({ slotCapacity: 5, firstSlotHour: 20, lastSlotHour: 8, minLeadMinutes: 60 }), /mayor/);
  rejects(() => parseSettings({ slotCapacity: 5, firstSlotHour: 8, lastSlotHour: 20 }));
});

test('parseProductFilter aplica valores por defecto y rechaza parámetros inválidos o repetidos', () => {
  assert.deepEqual(parseProductFilter({}, 'active', false), { onSale: false, status: 'active', sort: 'relevance', page: 1, pageSize: 12 });
  const filter = parseProductFilter({ q: ' Audífonos ', categoryId: UUID.toUpperCase(), minPriceCents: '100', maxPriceCents: '500', onSale: 'true', sort: 'price_asc', page: '2', pageSize: '24' }, 'active', false);
  assert.deepEqual(filter, { q: 'Audífonos', categoryId: UUID, minPriceCents: 100, maxPriceCents: 500, onSale: true, status: 'active', sort: 'price_asc', page: 2, pageSize: 24 });
  // El cliente no puede pedir inactivos: el parámetro status se ignora si no es administrador.
  assert.equal(parseProductFilter({ status: 'all' }, 'active', false).status, 'active');
  assert.equal(parseProductFilter({ status: 'inactive' }, 'all', true).status, 'inactive');
  rejects(() => parseProductFilter({ status: 'otro' }, 'all', true));
  for (const query of [{ q: ['a', 'b'] }, { page: ['1', '2'] }, { q: '\u{1F6B2}' }, { page: '0' }, { page: '10001' }, { pageSize: '51' }, { minPriceCents: '-1' }, { minPriceCents: '1e3' }, { sort: 'azar' }, { onSale: '1' }, { categoryId: 'x' }]) {
    rejects(() => parseProductFilter(query as never, 'active', false), undefined);
  }
});

test('parseDeliverySlotsQuery y validateImageKey', () => {
  assert.deepEqual(parseDeliverySlotsQuery({ zoneId: UUID, date: '2030-05-10' }), { zoneId: UUID, date: '2030-05-10' });
  rejects(() => parseDeliverySlotsQuery({ zoneId: UUID }));
  rejects(() => parseDeliverySlotsQuery({ zoneId: UUID, date: '2030-02-30' }));
  rejects(() => parseDeliverySlotsQuery({ date: '2030-05-10' }));
  assert.equal(validateImageKey(`${'ab'.repeat(16)}.png`), `${'ab'.repeat(16)}.png`);
  for (const bad of ['../x.png', `${'AB'.repeat(16)}.png`, `${'ab'.repeat(16)}.gif`, `${'ab'.repeat(15)}.png`, 7, null, undefined, `${'ab'.repeat(16)}.png/`]) rejects(() => validateImageKey(bad));
});

test('mapStoreSqlError traduce los códigos de PostgreSQL a errores de negocio sin filtrar detalles', () => {
  const fake = (code: string, message = '') => ({ code: 'P2010', message: `Raw query failed. ${message}`, meta: { driverAdapterError: { cause: { originalCode: code, message } } } });
  const cases: Array<[unknown, string]> = [
    [fake('23505', 'duplicate key value violates unique constraint "products_sku_idx"'), 'DUPLICATE_SKU'],
    [fake('23505', 'unique constraint "categories_name_key_idx"'), 'DUPLICATE_CATEGORY'],
    [fake('LG404', 'CATEGORY_NOT_FOUND'), 'CATEGORY_NOT_FOUND'],
    [fake('LG404', 'PRODUCT_NOT_FOUND'), 'PRODUCT_NOT_FOUND'],
    [fake('LG409', 'VERSION_CONFLICT'), 'VERSION_CONFLICT'],
    [fake('LG412', 'INSUFFICIENT_STOCK'), 'INSUFFICIENT_STOCK'],
    [fake('42501', 'ACTOR_NOT_ALLOWED'), 'FORBIDDEN'],
    [fake('23503', 'ZONE_NOT_FOUND'), 'ZONE_NOT_FOUND'],
    [fake('23503', 'CUSTOMER_USER_NOT_FOUND'), 'FORBIDDEN'],
    [fake('23503', 'products_category_id_fkey'), 'CATEGORY_NOT_FOUND'],
    [fake('23514', 'IDEMPOTENCY_PAYLOAD_CONFLICT'), 'IDEMPOTENCY_KEY_REUSED'],
    [fake('23514', 'products_price_cents_check'), 'VALIDATION_ERROR'],
    [fake('55P03', 'OPERATION_NOT_FINISHED'), 'OPERATION_IN_PROGRESS'],
    [fake('22023', 'INVALID_ITEMS'), 'VALIDATION_ERROR'],
    [fake('22004', 'IDEMPOTENCY_KEY_REQUIRED'), 'VALIDATION_ERROR'],
    [fake('XX000', 'algo raro con la contraseña secreta123'), 'PERSISTENCE_UNAVAILABLE'],
    [new Error('conexión rechazada postgresql://logistica_app:secreta@host'), 'PERSISTENCE_UNAVAILABLE'],
    [null, 'PERSISTENCE_UNAVAILABLE'],
  ];
  for (const [error, code] of cases) {
    const mapped = mapStoreSqlError(error);
    assert.equal(mapped.code, code);
    assert.equal(mapped.message.includes('secreta'), false, 'el mensaje no debe filtrar datos del controlador');
    assert.equal(mapped.message.includes('postgresql://'), false);
  }
  const own = new StoreError('FORBIDDEN');
  assert.equal(mapStoreSqlError(own), own);
});

test('isRetryableSqlError solo reintenta interbloqueos y fallos de serialización', () => {
  const fake = (code: string) => ({ meta: { driverAdapterError: { cause: { originalCode: code } } } });
  assert.equal(isRetryableSqlError(fake('40P01')), true);
  assert.equal(isRetryableSqlError(fake('40001')), true);
  for (const code of ['23505', '23514', 'LG409', '55P03', '57014']) assert.equal(isRetryableSqlError(fake(code)), false, code);
  assert.equal(isRetryableSqlError(new Error('x')), false);
});

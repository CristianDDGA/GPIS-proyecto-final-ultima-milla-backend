import { validateAddressText, validatePersonName } from '../../../shared/text-validation.js';
import {
  validateBrandName,
  validateCategoryName,
  validateProductDescription,
  validateProductName,
  validateSearchText,
  validateSku,
} from '../../../shared/store-text-validation.js';
import { StoreError } from './store.errors.js';
import {
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  PRODUCT_SORTS,
  STOCK_REASONS,
  type NewProduct,
  type OrderItemInput,
  type PlaceOrderCommand,
  type ProductFilter,
  type ProductPatch,
  type ProductSort,
  type ProductStatusFilter,
  type StockReason,
  type StoreSettings,
} from './store.types.js';

// Toda entrada pasa por aquí: tipos estrictos, listas blancas de campos (sin asignación masiva) y rangos.

export const MAX_PRICE_CENTS = 100_000_000; // USD 1.000.000,00
export const MAX_STOCK = 1_000_000;
const MAX_NOTE_LENGTH = 300;

export function fail(message: string): never {
  throw new StoreError('VALIDATION_ERROR', message);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_KEY_RE = /^[0-9a-f]{32}\.(?:jpg|png)$/;

export function bodyObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    return fail('El cuerpo debe ser un objeto JSON.');
  }
  return value as Record<string, unknown>;
}

/** Rechaza campos desconocidos: evita asignación masiva y errores de escritura silenciosos. */
export function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fail(`El campo '${key.slice(0, 40)}' no está permitido.`);
  }
}

export function validateUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) return fail(`${label} no es un identificador válido.`);
  return value.toLowerCase();
}

export function validateImageKey(value: unknown): string {
  if (typeof value !== 'string' || !IMAGE_KEY_RE.test(value)) return fail('El nombre de la imagen no es válido.');
  return value;
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail(`${label} debe ser un número entero.`);
  if (value < min || value > max) return fail(`${label} debe estar entre ${min} y ${max}.`);
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return fail(`${label} debe ser verdadero o falso.`);
  return value;
}

export function requireField(body: Record<string, unknown>, key: string, label: string): unknown {
  if (!(key in body) || body[key] === undefined) return fail(`${label} es obligatorio.`);
  return body[key];
}

export function checkedText(result: { ok: true; value: string } | { ok: false; reason: string }): string {
  if (!result.ok) return fail(result.reason);
  return result.value;
}

export function nullableText(value: unknown, validate: (value: unknown) => { ok: true; value: string } | { ok: false; reason: string }): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return checkedText(validate(value));
}

export function expectedVersion(body: Record<string, unknown>): number {
  return integer(requireField(body, 'expectedVersion', 'expectedVersion'), 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
}

// ---------------------------------------------------------------------------------------------- consultas

export function queryString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return fail(`El parámetro ${key} debe aparecer una sola vez y ser texto.`);
  return value;
}

export function queryInteger(query: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const raw = queryString(query, key);
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{1,10}$/.test(raw)) return fail(`El parámetro ${key} debe ser un número entero.`);
  const value = Number(raw);
  if (value < min || value > max) return fail(`El parámetro ${key} debe estar entre ${min} y ${max}.`);
  return value;
}

export function parsePaging(query: Record<string, unknown>, defaultPageSize: number): { page: number; pageSize: number } {
  return {
    page: queryInteger(query, 'page', 1, 10_000) ?? 1,
    pageSize: queryInteger(query, 'pageSize', 1, 50) ?? defaultPageSize,
  };
}

export function parseProductFilter(query: Record<string, unknown>, defaultStatus: ProductStatusFilter, allowStatus: boolean): ProductFilter {
  const rawQ = queryString(query, 'q');
  const q = rawQ === undefined || rawQ.trim() === '' ? undefined : checkedText(validateSearchText(rawQ));
  const rawCategory = queryString(query, 'categoryId');
  const categoryId = rawCategory === undefined || rawCategory === '' ? undefined : validateUuid(rawCategory, 'categoryId');
  const minPriceCents = queryInteger(query, 'minPriceCents', 0, MAX_PRICE_CENTS);
  const maxPriceCents = queryInteger(query, 'maxPriceCents', 0, MAX_PRICE_CENTS);
  if (minPriceCents !== undefined && maxPriceCents !== undefined && minPriceCents > maxPriceCents) {
    fail('minPriceCents no puede ser mayor que maxPriceCents.');
  }
  const rawOnSale = queryString(query, 'onSale');
  if (rawOnSale !== undefined && rawOnSale !== 'true' && rawOnSale !== 'false') fail('onSale debe ser true o false.');
  const rawSort = queryString(query, 'sort');
  if (rawSort !== undefined && rawSort !== '' && !PRODUCT_SORTS.includes(rawSort as ProductSort)) {
    fail(`sort debe ser uno de: ${PRODUCT_SORTS.join(', ')}.`);
  }
  let status: ProductStatusFilter = defaultStatus;
  const rawStatus = queryString(query, 'status');
  if (allowStatus && rawStatus !== undefined && rawStatus !== '') {
    if (rawStatus !== 'active' && rawStatus !== 'inactive' && rawStatus !== 'all') fail('status debe ser active, inactive o all.');
    status = rawStatus;
  }
  const { page, pageSize } = parsePaging(query, 12);
  return {
    ...(q !== undefined ? { q } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(minPriceCents !== undefined ? { minPriceCents } : {}),
    ...(maxPriceCents !== undefined ? { maxPriceCents } : {}),
    onSale: rawOnSale === 'true',
    status,
    sort: rawSort === undefined || rawSort === '' ? 'relevance' : (rawSort as ProductSort),
    page,
    pageSize,
  };
}

export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseDeliverySlotsQuery(query: Record<string, unknown>): { zoneId: string; date: string } {
  const zoneId = validateUuid(queryString(query, 'zoneId'), 'zoneId');
  const date = queryString(query, 'date');
  if (date === undefined || !isIsoDate(date)) return fail('date debe ser una fecha válida con formato AAAA-MM-DD.');
  return { zoneId, date };
}

// ---------------------------------------------------------------------------------------------- catálogo (administrador)

export function parseNewCategory(body: Record<string, unknown>): string {
  onlyKeys(body, ['name']);
  return checkedText(validateCategoryName(requireField(body, 'name', 'El nombre')));
}

export function parseCategoryPatch(body: Record<string, unknown>): { name?: string; isActive?: boolean; expectedVersion: number } {
  onlyKeys(body, ['expectedVersion', 'name', 'isActive']);
  const version = expectedVersion(body);
  const patch: { name?: string; isActive?: boolean } = {};
  if ('name' in body) patch.name = checkedText(validateCategoryName(body['name']));
  if ('isActive' in body) patch.isActive = boolean(body['isActive'], 'isActive');
  if (Object.keys(patch).length === 0) fail('No hay cambios que aplicar.');
  return { ...patch, expectedVersion: version };
}

function priceFields(body: Record<string, unknown>): { priceCents?: number; compareAtPriceCents?: number | null } {
  const out: { priceCents?: number; compareAtPriceCents?: number | null } = {};
  if ('priceCents' in body) out.priceCents = integer(body['priceCents'], 'priceCents', 1, MAX_PRICE_CENTS);
  if ('compareAtPriceCents' in body) {
    out.compareAtPriceCents = body['compareAtPriceCents'] === null ? null : integer(body['compareAtPriceCents'], 'compareAtPriceCents', 2, MAX_PRICE_CENTS);
  }
  if (out.priceCents !== undefined && typeof out.compareAtPriceCents === 'number' && out.compareAtPriceCents <= out.priceCents) {
    fail('El precio de lista (compareAtPriceCents) debe ser mayor que el precio de venta (priceCents).');
  }
  return out;
}

export function parseNewProduct(body: Record<string, unknown>): NewProduct {
  // La imagen no se acepta aquí: solo se asigna al subir un archivo, para que nadie apunte a un archivo ajeno.
  onlyKeys(body, ['sku', 'name', 'brand', 'description', 'categoryId', 'priceCents', 'compareAtPriceCents', 'stock', 'isActive']);
  const prices = priceFields(body);
  if (prices.priceCents === undefined) fail('El precio (priceCents) es obligatorio.');
  return {
    sku: checkedText(validateSku(requireField(body, 'sku', 'El SKU'))),
    name: checkedText(validateProductName(requireField(body, 'name', 'El nombre'))),
    brand: 'brand' in body ? nullableText(body['brand'], (value) => validateBrandName(value)) : null,
    description: 'description' in body ? nullableText(body['description'], (value) => validateProductDescription(value)) : null,
    categoryId: validateUuid(requireField(body, 'categoryId', 'La categoría'), 'categoryId'),
    priceCents: prices.priceCents,
    compareAtPriceCents: prices.compareAtPriceCents ?? null,
    stock: integer(requireField(body, 'stock', 'El stock'), 'stock', 0, MAX_STOCK),
    imageKey: null,
    isActive: 'isActive' in body ? boolean(body['isActive'], 'isActive') : true,
  };
}

export function parseProductPatch(body: Record<string, unknown>): { patch: ProductPatch; expectedVersion: number } {
  onlyKeys(body, ['expectedVersion', 'name', 'brand', 'description', 'categoryId', 'priceCents', 'compareAtPriceCents', 'isActive']);
  const version = expectedVersion(body);
  const patch: { -readonly [K in keyof ProductPatch]: ProductPatch[K] } = { ...priceFields(body) };
  if ('name' in body) patch.name = checkedText(validateProductName(body['name']));
  if ('brand' in body) patch.brand = nullableText(body['brand'], (value) => validateBrandName(value));
  if ('description' in body) patch.description = nullableText(body['description'], (value) => validateProductDescription(value));
  if ('categoryId' in body) patch.categoryId = validateUuid(body['categoryId'], 'categoryId');
  if ('isActive' in body) patch.isActive = boolean(body['isActive'], 'isActive');
  if (Object.keys(patch).length === 0) fail('No hay cambios que aplicar.');
  return { patch, expectedVersion: version };
}

export function parseStockAdjustment(body: Record<string, unknown>): { delta: number; reason: StockReason } {
  onlyKeys(body, ['delta', 'reason']);
  const delta = integer(requireField(body, 'delta', 'delta'), 'delta', -100_000, 100_000);
  if (delta === 0) fail('delta no puede ser 0.');
  const reason = requireField(body, 'reason', 'El motivo');
  if (typeof reason !== 'string' || !STOCK_REASONS.includes(reason as StockReason)) {
    return fail(`El motivo debe ser uno de: ${STOCK_REASONS.join(', ')}.`);
  }
  return { delta, reason: reason as StockReason };
}

export function parseSettings(body: Record<string, unknown>): StoreSettings {
  onlyKeys(body, ['slotCapacity', 'firstSlotHour', 'lastSlotHour', 'minLeadMinutes']);
  const settings: StoreSettings = {
    slotCapacity: integer(requireField(body, 'slotCapacity', 'slotCapacity'), 'slotCapacity', 1, 500),
    firstSlotHour: integer(requireField(body, 'firstSlotHour', 'firstSlotHour'), 'firstSlotHour', 0, 23),
    lastSlotHour: integer(requireField(body, 'lastSlotHour', 'lastSlotHour'), 'lastSlotHour', 0, 23),
    minLeadMinutes: integer(requireField(body, 'minLeadMinutes', 'minLeadMinutes'), 'minLeadMinutes', 0, 10_080),
  };
  if (settings.firstSlotHour > settings.lastSlotHour) fail('firstSlotHour no puede ser mayor que lastSlotHour.');
  return settings;
}

// ---------------------------------------------------------------------------------------------- pedido

function parseItems(value: unknown): OrderItemInput[] {
  if (!Array.isArray(value)) return fail('items debe ser una lista de productos.');
  if (value.length < 1) return fail('El pedido debe incluir al menos un producto.');
  if (value.length > MAX_ORDER_LINES) return fail(`El pedido no puede tener más de ${MAX_ORDER_LINES} productos distintos.`);
  const seen = new Set<string>();
  return value.map((raw: unknown, index) => {
    const line = bodyObject(raw);
    onlyKeys(line, ['productId', 'quantity', 'unitPriceCents']);
    const productId = validateUuid(line['productId'], `items[${index}].productId`);
    if (seen.has(productId)) fail('Un producto no puede repetirse en el pedido; suma sus cantidades en una sola línea.');
    seen.add(productId);
    return {
      productId,
      quantity: integer(line['quantity'], `items[${index}].quantity`, 1, MAX_LINE_QUANTITY),
      unitPriceCents: integer(line['unitPriceCents'], `items[${index}].unitPriceCents`, 1, MAX_PRICE_CENTS),
    };
  });
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    return fail('La cabecera Idempotency-Key es obligatoria y debe ser un UUID.');
  }
  return value.trim().toLowerCase();
}

/** Rectángulo de Ecuador (incluye Galápagos): atrapa pines mal puestos. Igual que valid_coordinates() en la migración 013. */
export const ECUADOR_BOUNDS = { minLat: -5.1, maxLat: 1.5, minLng: -92.5, maxLng: -75.0 } as const;

export interface Coordinates { readonly latitude: number | null; readonly longitude: number | null }

function coordinate(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${label} debe ser un número.`);
  if (value < min || value > max) return fail(`${label} está fuera de Ecuador: debe estar entre ${min} y ${max}.`);
  return value;
}

/** Pin opcional del mapa. Latitud y longitud van juntas o ninguna; null (o ausentes) significa dirección manual. */
export function parseCoordinates(body: Record<string, unknown>): Coordinates {
  const lat = body['latitude'];
  const lng = body['longitude'];
  const noLat = lat === undefined || lat === null;
  const noLng = lng === undefined || lng === null;
  if (noLat && noLng) return { latitude: null, longitude: null };
  if (noLat || noLng) return fail('La latitud y la longitud deben enviarse juntas.');
  return {
    latitude: coordinate(lat, 'La latitud', ECUADOR_BOUNDS.minLat, ECUADOR_BOUNDS.maxLat),
    longitude: coordinate(lng, 'La longitud', ECUADOR_BOUNDS.minLng, ECUADOR_BOUNDS.maxLng),
  };
}

export function parsePlaceOrder(body: Record<string, unknown>, idempotencyKeyHeader: unknown, customerId: string): PlaceOrderCommand {
  onlyKeys(body, ['zoneId', 'deliveryAddress', 'deliveryDate', 'deliveryTime', 'recipientName', 'recipientPhone', 'notes', 'items', 'latitude', 'longitude']);
  const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
  const deliveryDate = requireField(body, 'deliveryDate', 'La fecha de entrega');
  if (typeof deliveryDate !== 'string' || !isIsoDate(deliveryDate)) fail('La fecha de entrega debe tener formato AAAA-MM-DD y ser una fecha real.');
  const deliveryTime = requireField(body, 'deliveryTime', 'La hora de entrega');
  if (typeof deliveryTime !== 'string' || !/^(?:[01]\d|2[0-3]):00$/.test(deliveryTime)) {
    fail('La hora de entrega debe ser una hora en punto con formato HH:00 (por ejemplo 14:00).');
  }
  let recipientPhone: string | null = null;
  if ('recipientPhone' in body && body['recipientPhone'] !== null && body['recipientPhone'] !== '') {
    const raw = body['recipientPhone'];
    if (typeof raw !== 'string' || !/^\+?\d(?:[ -]?\d){6,14}$/.test(raw.trim())) {
      fail('El teléfono debe tener entre 7 y 15 dígitos (puede iniciar con +).');
    }
    recipientPhone = (raw as string).trim().replace(/[ -]/g, '');
  }
  let notes: string | null = null;
  if ('notes' in body && body['notes'] !== null && body['notes'] !== '') {
    notes = checkedText(validateProductDescription(body['notes'], 'Las notas'));
    if (notes.length > MAX_NOTE_LENGTH) fail(`Las notas no pueden superar ${MAX_NOTE_LENGTH} caracteres.`);
  }
  return {
    customerId,
    zoneId: validateUuid(requireField(body, 'zoneId', 'La zona'), 'zoneId'),
    deliveryAddress: checkedText(validateAddressText(requireField(body, 'deliveryAddress', 'La dirección'), 'La dirección de entrega')),
    deliveryDate: deliveryDate as string,
    deliveryTime: deliveryTime as string,
    recipientName: 'recipientName' in body && body['recipientName'] !== null && body['recipientName'] !== ''
      ? checkedText(validatePersonName(body['recipientName'], 'El nombre del destinatario'))
      : null,
    recipientPhone,
    notes,
    items: parseItems(requireField(body, 'items', 'La lista de productos')),
    idempotencyKey,
    ...parseCoordinates(body),
  };
}

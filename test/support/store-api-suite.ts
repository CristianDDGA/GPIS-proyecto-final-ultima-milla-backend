import request from 'supertest';
import type { createApp } from '../../src/bootstrap/create-app.js';
import type { InMemoryFileStorage } from '../../src/modules/courier-applications/infrastructure/storage/in-memory-file-storage.js';

// Suite HTTP de la tienda. Se ejecuta IGUAL contra el repositorio en memoria y contra PostgreSQL real
// (migración 010): lo que cambia es solo cómo se arma el arnés. Los resultados deben ser idénticos.

/** Despacho simulado: en producción lo hacen los módulos de rutas y entregas; aquí se reproduce para probar los flujos. */
export interface StoreDispatch {
  /** Crea una ruta con esos pedidos y la asigna al conductor del arnés. Devuelve el id de la ruta. */
  assign(orderIds: readonly string[]): Promise<string>;
  advance(orderId: string, to: 'recogido' | 'en_camino'): Promise<void>;
  /** Cierra la ruta (todas sus paradas entregadas o con entrega fallida). */
  closeRoute(routeId: string): Promise<void>;
}

export interface StoreHarness {
  readonly app: ReturnType<typeof createApp>;
  readonly driverUserId: string;
  readonly dispatch: StoreDispatch;
  /** Tipos de aviso por correo que quedaron en cola para el pedido, en orden de creación. */
  readonly notificationKinds: (orderId: string) => Promise<string[]>;
  readonly adminToken: string;
  readonly customerToken: string;
  readonly otherCustomerToken: string;
  readonly driverToken: string;
  /** Zona activa con cobertura: un círculo de 50 km alrededor de `pin`. */
  readonly zoneId: string;
  /** Zona activa SIN cobertura definida: no es operativa y no recibe pedidos. */
  readonly uncoveredZoneId: string;
  readonly inactiveZoneId: string;
  readonly missingZoneId: string;
  /** Punto del mapa dentro de la cobertura de `zoneId`. */
  readonly pin: { readonly latitude: number; readonly longitude: number };
  readonly images: InMemoryFileStorage;
}

/** Centro y radio de la cobertura que usan los arneses (Quito). */
export const TEST_COVERAGE = { latitude: -0.1807, longitude: -78.4678, radiusKm: 50 } as const;

export interface StoreHarnessOptions {
  readonly storeRateLimit?: { readonly maxRequests: number; readonly windowMs: number };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const uuid = () => crypto.randomUUID();

export function futureDate(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + days * 86_400_000),
  );
}

/** PNG mínimo con la cabecera IHDR: alcanza para que el servidor lea tipo y dimensiones. */
export function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(48);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

export function defineStoreApiSuite(
  create: (options?: StoreHarnessOptions) => Promise<StoreHarness> | StoreHarness,
): void {
  let h: StoreHarness;
  beforeEach(async () => { h = await create(); });

  const api = () => request(h.app);
  const asAdmin = () => bearer(h.adminToken);
  const asCustomer = () => bearer(h.customerToken);

  async function newCategory(name = 'Deportes y fitness'): Promise<{ id: string; version: number }> {
    const response = await api().post('/store/admin/categories').set(asAdmin()).send({ name });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function newProduct(categoryId: string, overrides: Record<string, unknown> = {}) {
    const response = await api().post('/store/admin/products').set(asAdmin()).send({
      sku: `P-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: 'Audífonos inalámbricos serie 100',
      brand: 'SoundMax',
      description: 'Cancelación de ruido activa.',
      categoryId,
      priceCents: 6999,
      compareAtPriceCents: 8999,
      stock: 10,
      ...overrides,
    });
    expect(response.status).toBe(201);
    return response.body as { id: string; version: number; priceCents: number; stockQuantity: number; sku: string };
  }

  function orderBody(productId: string, overrides: Record<string, unknown> = {}, quantity = 1, price = 6999) {
    return {
      zoneId: h.zoneId,
      deliveryAddress: 'Av. 9 de Octubre 123 y Malecón',
      deliveryDate: futureDate(3),
      deliveryTime: '10:00',
      latitude: h.pin.latitude,
      longitude: h.pin.longitude,
      items: [{ productId, quantity, unitPriceCents: price }],
      ...overrides,
    };
  }

  const placeOrder = (body: unknown, key: string = uuid(), token: string = h.customerToken) =>
    api().post('/store/orders').set(bearer(token)).set('Idempotency-Key', key).send(body as object);

  // ------------------------------------------------------------------------------------------- permisos
  describe('Permisos por rol', () => {
    it('sin sesión todo exige autenticación, salvo leer una imagen pública', async () => {
      expect((await api().get('/store/products')).status).toBe(401);
      expect((await api().get('/store/admin/products')).status).toBe(401);
      expect((await api().post('/store/orders').send({})).status).toBe(401);
      expect((await api().get(`/store/images/${'a'.repeat(32)}.png`)).status).toBe(404);
    });

    it('un repartidor no puede usar la tienda', async () => {
      const driver = bearer(h.driverToken);
      expect((await api().get('/store/products').set(driver)).status).toBe(403);
      expect((await api().get('/store/categories').set(driver)).status).toBe(403);
      expect((await api().get('/store/delivery-slots').set(driver)).status).toBe(403);
      expect((await api().get('/store/orders').set(driver)).status).toBe(403);
    });

    it('un cliente no puede administrar el catálogo ni cambiar la configuración', async () => {
      const customer = asCustomer();
      expect((await api().get('/store/admin/products').set(customer)).status).toBe(403);
      expect((await api().post('/store/admin/categories').set(customer).send({ name: 'Hogar' })).status).toBe(403);
      expect((await api().post('/store/admin/products').set(customer).send({})).status).toBe(403);
      expect((await api().put('/store/admin/settings').set(customer).send({})).status).toBe(403);
    });

    it('un administrador no puede hacer pedidos y cualquier ruta desconocida de /store se niega a un cliente', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      expect((await placeOrder(orderBody(product.id), uuid(), h.adminToken)).status).toBe(403);
      expect((await api().patch('/store/orders/lo-que-sea').set(asCustomer()).send({})).status).toBe(403);
      expect((await api().delete('/store/products').set(asCustomer())).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------- categorías y productos (administrador)
  describe('Administración del catálogo', () => {
    it('crea categorías, rechaza duplicados sin distinguir mayúsculas y controla la versión', async () => {
      const category = await newCategory('Deportes y fitness');
      expect(category.version).toBe(1);
      const duplicate = await api().post('/store/admin/categories').set(asAdmin()).send({ name: 'DEPORTES Y FITNESS' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('DUPLICATE_CATEGORY');

      const renamed = await api().patch(`/store/admin/categories/${category.id}`).set(asAdmin()).send({ expectedVersion: 1, name: 'Deportes' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.version).toBe(2);
      const stale = await api().patch(`/store/admin/categories/${category.id}`).set(asAdmin()).send({ expectedVersion: 1, name: 'Otro nombre' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
    });

    it.each([
      ['un emoji', 'Bebé \u{1F37C}'],
      ['un dígito keycap', 'Tecnología 1️⃣'],
      ['un símbolo', 'Hogar ™'],
      ['caracteres de control', 'Hogar\u0007'],
      ['solo una letra', 'A'],
    ])('rechaza una categoría con %s', async (_why, name) => {
      const response = await api().post('/store/admin/categories').set(asAdmin()).send({ name });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('crea un producto con números en el nombre y devuelve su versión y stock exacto', async () => {
      const category = await newCategory();
      const response = await api().post('/store/admin/products').set(asAdmin()).send({
        sku: 'band-5', name: 'Bandas de resistencia set 5 niveles', categoryId: category.id, priceCents: 1549, stock: 25,
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ sku: 'BAND-5', name: 'Bandas de resistencia set 5 niveles', version: 1, stockQuantity: 25, isActive: true, imageUrl: null });
    });

    it.each([
      ['un emoji', { name: 'Mesa \u{1F6B2}' }],
      ['un dígito keycap', { name: 'Set 1️⃣ piezas' }],
      ['una marca combinante envolvente', { name: 'Set 5⃣ piezas' }],
      ['un carácter invisible (ZWJ)', { name: 'Hogar\u200Dcasa' }],
      ['letras de otro alfabeto', { name: 'Привет mundo' }],
      ['texto apilado (zalgo)', { name: 'Zó́́́na' }],
      ['una etiqueta HTML', { name: '<script>alert(1)</script>' }],
      ['una marca con emoji', { brand: 'Marca \u{1F525}' }],
      ['una descripción con emoji', { description: 'Muy bueno \u{1F44D}' }],
      ['un SKU inválido', { sku: 'a' }],
      ['un precio cero', { priceCents: 0 }],
      ['un precio con decimales', { priceCents: 19.99 }],
      ['un precio como texto', { priceCents: '1999' }],
      ['un precio en notación científica', { priceCents: 1e12 }],
      ['un stock negativo', { stock: -1 }],
      ['un precio de lista menor al de venta', { priceCents: 5000, compareAtPriceCents: 4000 }],
      ['un precio de lista igual al de venta', { priceCents: 5000, compareAtPriceCents: 5000 }],
      ['un campo desconocido (asignación masiva)', { isAdmin: true }],
      ['la imagen asignada a mano', { imageKey: `${'a'.repeat(32)}.png` }],
    ])('rechaza crear un producto con %s', async (_why, overrides) => {
      const category = await newCategory();
      const response = await api().post('/store/admin/products').set(asAdmin()).send({
        sku: 'OK-100', name: 'Producto válido', categoryId: category.id, priceCents: 1000, stock: 5, ...overrides,
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      const listed = await api().get('/store/admin/products').set(asAdmin());
      expect(listed.body.total).toBe(0);
    });

    it('rechaza un SKU repetido y una categoría inexistente', async () => {
      const category = await newCategory();
      await newProduct(category.id, { sku: 'DUP-1' });
      const duplicate = await api().post('/store/admin/products').set(asAdmin()).send({
        sku: 'dup-1', name: 'Otro producto', categoryId: category.id, priceCents: 100, stock: 1,
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('DUPLICATE_SKU');
      const orphan = await api().post('/store/admin/products').set(asAdmin()).send({
        sku: 'ORF-1', name: 'Sin categoría', categoryId: uuid(), priceCents: 100, stock: 1,
      });
      expect(orphan.status).toBe(404);
      expect(orphan.body.code).toBe('CATEGORY_NOT_FOUND');
    });

    it('edita con control de versión: el segundo administrador con datos viejos recibe 409', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      const first = await api().patch(`/store/admin/products/${product.id}`).set(asAdmin()).send({ expectedVersion: 1, priceCents: 5999 });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ priceCents: 5999, version: 2 });
      const stale = await api().patch(`/store/admin/products/${product.id}`).set(asAdmin()).send({ expectedVersion: 1, priceCents: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.priceCents).toBe(5999);
    });

    it('rechaza cambios vacíos, sin versión o con campos fuera de la lista', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      const patch = (body: object) => api().patch(`/store/admin/products/${product.id}`).set(asAdmin()).send(body);
      expect((await patch({ expectedVersion: 1 })).status).toBe(400);
      expect((await patch({ priceCents: 500 })).status).toBe(400);
      expect((await patch({ expectedVersion: 1, sku: 'NUEVO-1' })).status).toBe(400);
      expect((await patch({ expectedVersion: 1, stockQuantity: 99 })).status).toBe(400);
      expect((await patch({ expectedVersion: 1, name: 'Mesa \u{1F6B2}' })).status).toBe(400);
      expect((await patch({ expectedVersion: 1, priceCents: 500, compareAtPriceCents: 400 })).status).toBe(400);
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.version).toBe(1);
    });

    it('ajusta el stock por diferencia, sin dejarlo negativo y sin cambiar la versión', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 4 });
      const adjust = (body: object) => api().post(`/store/admin/products/${product.id}/stock-adjustments`).set(asAdmin()).send(body);
      expect((await adjust({ delta: 6, reason: 'restock' })).body.stock).toBe(10);
      expect((await adjust({ delta: -3, reason: 'damage' })).body.stock).toBe(7);
      const tooMuch = await adjust({ delta: -8, reason: 'correction' });
      expect(tooMuch.status).toBe(409);
      expect(tooMuch.body.code).toBe('INSUFFICIENT_STOCK');
      expect((await adjust({ delta: 0, reason: 'restock' })).status).toBe(400);
      expect((await adjust({ delta: 1.5, reason: 'restock' })).status).toBe(400);
      expect((await adjust({ delta: 1, reason: 'sale' })).status).toBe(400);
      const after = await api().get(`/store/admin/products/${product.id}`).set(asAdmin());
      expect(after.body).toMatchObject({ stockQuantity: 7, version: 1 });
      expect((await adjust({ delta: 1, reason: 'restock' })).status).toBe(200);
    });

    it('guarda un historial de cambios con quién y qué cambió', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      await api().patch(`/store/admin/products/${product.id}`).set(asAdmin()).send({ expectedVersion: 1, isActive: false });
      await api().post(`/store/admin/products/${product.id}/stock-adjustments`).set(asAdmin()).send({ delta: 2, reason: 'restock' });
      const events = await api().get(`/store/admin/products/${product.id}/events`).set(asAdmin());
      expect(events.status).toBe(200);
      const actions = (events.body.items as Array<{ action: string }>).map((event) => event.action);
      expect(actions).toEqual(expect.arrayContaining(['created', 'deactivated', 'stock_adjusted']));
    });
  });

  // ------------------------------------------------------------------------------------------- catálogo (cliente)
  describe('Catálogo para el cliente', () => {
    async function seedCatalog() {
      const sports = await newCategory('Deportes y fitness');
      const home = await newCategory('Hogar y cocina');
      const headphones = await newProduct(sports.id, { sku: 'AUD-1', name: 'Audífonos inalámbricos con cancelación de ruido', brand: 'SoundMax', priceCents: 6999, compareAtPriceCents: 8999, stock: 20 });
      const bands = await newProduct(sports.id, { sku: 'BAND-5', name: 'Bandas de resistencia set 5 niveles', brand: 'FitFlex', priceCents: 1549, compareAtPriceCents: 1999, stock: 3 });
      const scale = await newProduct(home.id, { sku: 'BASC-1', name: 'Báscula digital de baño', brand: 'FitScale', description: null, priceCents: 2249, compareAtPriceCents: null, stock: 0 });
      const hidden = await newProduct(home.id, { sku: 'OCU-1', name: 'Producto oculto', priceCents: 500, compareAtPriceCents: null, stock: 5, isActive: false });
      return { sports, home, headphones, bands, scale, hidden };
    }

    it('lista solo productos activos, sin datos internos, con disponibilidad y descuento', async () => {
      const { hidden } = await seedCatalog();
      const response = await api().get('/store/products').set(asCustomer());
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ total: 3, page: 1, pageSize: 12 });
      const names = (response.body.items as Array<{ name: string }>).map((item) => item.name);
      expect(names).not.toContain('Producto oculto');
      const bands = (response.body.items as Array<Record<string, unknown>>).find((item) => item['sku'] === 'BAND-5');
      expect(bands).toMatchObject({ availability: 'low_stock', lowStockRemaining: 3, discountPercent: 23, priceCents: 1549 });
      const scale = (response.body.items as Array<Record<string, unknown>>).find((item) => item['sku'] === 'BASC-1');
      expect(scale).toMatchObject({ availability: 'out_of_stock', lowStockRemaining: null, discountPercent: null });
      const headphones = (response.body.items as Array<Record<string, unknown>>).find((item) => item['sku'] === 'AUD-1');
      expect(headphones).toMatchObject({ availability: 'in_stock', lowStockRemaining: null });
      for (const item of response.body.items as Array<Record<string, unknown>>) {
        expect(item).not.toHaveProperty('version');
        expect(item).not.toHaveProperty('isActive');
        expect(item).not.toHaveProperty('stockQuantity');
        expect(item).not.toHaveProperty('imageKey');
      }
      expect((await api().get(`/store/products/${hidden.id}`).set(asCustomer())).status).toBe(404);
    });

    it('busca sin distinguir tildes ni mayúsculas, por nombre, marca o categoría', async () => {
      await seedCatalog();
      const find = async (q: string) => ((await api().get('/store/products').query({ q }).set(asCustomer())).body.items as Array<{ sku: string }>).map((item) => item.sku);
      expect(await find('audifonos')).toEqual(['AUD-1']);
      expect(await find('AUDÍFONOS cancelacion')).toEqual(['AUD-1']);
      expect(await find('soundmax')).toEqual(['AUD-1']);
      expect(await find('bascula')).toEqual(['BASC-1']);
      expect(await find('fitness')).toEqual(expect.arrayContaining(['AUD-1', 'BAND-5']));
      expect(await find('hogar')).toEqual(['BASC-1']);
      expect(await find('niveles')).toEqual(['BAND-5']);
      expect(await find('zzzz')).toEqual([]);
    });

    it('filtra por categoría, rango de precio y ofertas, y ordena por precio', async () => {
      const { sports } = await seedCatalog();
      const list = async (params: Record<string, string>) => (await api().get('/store/products').query(params).set(asCustomer())).body;
      expect((await list({ categoryId: sports.id })).total).toBe(2);
      expect((await list({ minPriceCents: '2000', maxPriceCents: '3000' })).items.map((item: { sku: string }) => item.sku)).toEqual(['BASC-1']);
      expect((await list({ onSale: 'true' })).total).toBe(2);
      expect((await list({ sort: 'price_asc' })).items.map((item: { sku: string }) => item.sku)).toEqual(['BAND-5', 'BASC-1', 'AUD-1']);
      expect((await list({ sort: 'price_desc' })).items.map((item: { sku: string }) => item.sku)).toEqual(['AUD-1', 'BASC-1', 'BAND-5']);
      expect((await list({ sort: 'discount', onSale: 'true' })).items[0].sku).toBe('BAND-5');
    });

    it('pagina el resultado', async () => {
      await seedCatalog();
      const first = await api().get('/store/products').query({ pageSize: '2', page: '1', sort: 'price_asc' }).set(asCustomer());
      const second = await api().get('/store/products').query({ pageSize: '2', page: '2', sort: 'price_asc' }).set(asCustomer());
      expect(first.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect(first.body.items).toHaveLength(2);
      expect(second.body.items).toHaveLength(1);
      const third = await api().get('/store/products').query({ pageSize: '2', page: '3' }).set(asCustomer());
      expect(third.body.items).toHaveLength(0);
      expect(third.body.total).toBe(3);
    });

    it.each([
      ['una búsqueda con emoji', { q: '\u{1F6B2}' }],
      ['una búsqueda con keycap', { q: 'set 1️⃣' }],
      ['una búsqueda con símbolos', { q: 'a; drop table x' }],
      ['una búsqueda demasiado larga', { q: 'x'.repeat(61) }],
      ['un precio mínimo mayor al máximo', { minPriceCents: '500', maxPriceCents: '100' }],
      ['un precio con decimales', { minPriceCents: '10.5' }],
      ['una página cero', { page: '0' }],
      ['un tamaño de página enorme', { pageSize: '5000' }],
      ['un orden desconocido', { sort: 'al_azar' }],
      ['onSale inválido', { onSale: 'quizas' }],
      ['una categoría que no es UUID', { categoryId: 'no-es-uuid' }],
    ])('rechaza %s con 400', async (_why, params) => {
      const response = await api().get('/store/products').query(params).set(asCustomer());
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('rechaza un parámetro repetido en vez de interpretarlo a medias', async () => {
      const response = await api().get('/store/products?q=a&q=b').set(asCustomer());
      expect(response.status).toBe(400);
    });

    it('el administrador ve también los inactivos y el stock exacto en su listado', async () => {
      await seedCatalog();
      const all = await api().get('/store/admin/products').set(asAdmin());
      expect(all.body.total).toBe(4);
      const inactive = await api().get('/store/admin/products').query({ status: 'inactive' }).set(asAdmin());
      expect(inactive.body.items.map((item: { sku: string }) => item.sku)).toEqual(['OCU-1']);
      expect(all.body.items[0]).toHaveProperty('stockQuantity');
      expect(all.body.items[0]).toHaveProperty('version');
    });

    it('una categoría desactivada oculta sus productos al cliente', async () => {
      const { home } = await seedCatalog();
      await api().patch(`/store/admin/categories/${home.id}`).set(asAdmin()).send({ expectedVersion: 1, isActive: false });
      const response = await api().get('/store/products').set(asCustomer());
      expect(response.body.items.map((item: { sku: string }) => item.sku).sort()).toEqual(['AUD-1', 'BAND-5']);
      expect((await api().get('/store/categories').set(asCustomer())).body.items).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------- franjas
  describe('Franjas de entrega', () => {
    it('devuelve una franja por hora con su cupo y se llena al agotarse', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 50 });
      const date = futureDate(3);
      await api().put('/store/admin/settings').set(asAdmin()).send({ slotCapacity: 1, firstSlotHour: 8, lastSlotHour: 20, minLeadMinutes: 60 });
      const before = await api().get('/store/delivery-slots').query({ zoneId: h.zoneId, date }).set(asCustomer());
      expect(before.status).toBe(200);
      expect(before.body.items).toHaveLength(13);
      expect(before.body.items[0]).toMatchObject({ time: '08:00', capacity: 1, reserved: 0, available: true });
      expect((await placeOrder(orderBody(product.id, { deliveryDate: date, deliveryTime: '11:00' }))).status).toBe(201);
      const after = await api().get('/store/delivery-slots').query({ zoneId: h.zoneId, date }).set(asCustomer());
      expect(after.body.items.find((slot: { time: string }) => slot.time === '11:00')).toMatchObject({ reserved: 1, available: false });
      expect(after.body.items.find((slot: { time: string }) => slot.time === '12:00')).toMatchObject({ reserved: 0, available: true });
    });

    it('una fecha pasada no tiene franjas disponibles', async () => {
      const response = await api().get('/store/delivery-slots').query({ zoneId: h.zoneId, date: '2000-01-01' }).set(asCustomer());
      expect(response.status).toBe(200);
      expect((response.body.items as Array<{ available: boolean }>).every((slot) => !slot.available)).toBe(true);
    });

    it('rechaza zona inexistente o inactiva y parámetros inválidos', async () => {
      const slots = (query: Record<string, string>) => api().get('/store/delivery-slots').query(query).set(asCustomer());
      expect((await slots({ zoneId: h.missingZoneId, date: futureDate(3) })).status).toBe(404);
      expect((await slots({ zoneId: h.inactiveZoneId, date: futureDate(3) })).status).toBe(404);
      expect((await slots({ zoneId: 'no-uuid', date: futureDate(3) })).status).toBe(400);
      expect((await slots({ zoneId: h.zoneId, date: '2026-02-31' })).status).toBe(400);
      expect((await slots({ zoneId: h.zoneId })).status).toBe(400);
    });

    it('valida la configuración de la tienda', async () => {
      const put = (body: object) => api().put('/store/admin/settings').set(asAdmin()).send(body);
      expect((await put({ slotCapacity: 5, firstSlotHour: 9, lastSlotHour: 18, minLeadMinutes: 30 })).status).toBe(200);
      expect((await api().get('/store/admin/settings').set(asAdmin())).body).toEqual({ slotCapacity: 5, firstSlotHour: 9, lastSlotHour: 18, minLeadMinutes: 30 });
      expect((await put({ slotCapacity: 0, firstSlotHour: 9, lastSlotHour: 18, minLeadMinutes: 30 })).status).toBe(400);
      expect((await put({ slotCapacity: 5, firstSlotHour: 18, lastSlotHour: 9, minLeadMinutes: 30 })).status).toBe(400);
      expect((await put({ slotCapacity: 5, firstSlotHour: 9, lastSlotHour: 24, minLeadMinutes: 30 })).status).toBe(400);
      expect((await put({ slotCapacity: 5, firstSlotHour: 9, lastSlotHour: 18 })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------------------------------- pedidos
  describe('Pedidos de la tienda', () => {
    it('crea el pedido, copia nombre y precio, descuenta el stock y lo devuelve con sus líneas', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 10 });
      const response = await placeOrder(orderBody(product.id, {}, 2));
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'pendiente', totalCents: 13998, itemsCount: 1, paymentMethod: 'contra_entrega', deliveryTime: '10:00',
      });
      expect(response.body.items[0]).toMatchObject({
        name: 'Audífonos inalámbricos serie 100', unitPriceCents: 6999, quantity: 2, lineTotalCents: 13998, imageUrl: null,
      });
      const stock = await api().get(`/store/admin/products/${product.id}`).set(asAdmin());
      expect(stock.body.stockQuantity).toBe(8);
      // El precio cambia después: el pedido conserva el precio con el que se compró.
      await api().patch(`/store/admin/products/${product.id}`).set(asAdmin()).send({ expectedVersion: 1, priceCents: 9999, compareAtPriceCents: null });
      const stored = await api().get(`/store/orders/${response.body.id}`).set(asCustomer());
      expect(stored.body.items[0].unitPriceCents).toBe(6999);
      expect(stored.body.totalCents).toBe(13998);
    });

    it('repetir la misma Idempotency-Key devuelve el mismo pedido sin descontar otra vez', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 10 });
      const key = uuid();
      const first = await placeOrder(orderBody(product.id), key);
      const second = await placeOrder(orderBody(product.id), key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.id).toBe(first.body.id);
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.stockQuantity).toBe(9);
      expect((await api().get('/store/orders').set(asCustomer())).body.total).toBe(1);
    });

    it('la misma clave con otro contenido se rechaza con 422', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      const key = uuid();
      expect((await placeOrder(orderBody(product.id), key)).status).toBe(201);
      const reused = await placeOrder(orderBody(product.id, {}, 3), key);
      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('exige una Idempotency-Key UUID', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      const noKey = await api().post('/store/orders').set(asCustomer()).send(orderBody(product.id));
      expect(noKey.status).toBe(400);
      expect((await placeOrder(orderBody(product.id), 'abc')).status).toBe(400);
    });

    it('si el precio cambió, responde 409 con el precio actual y no descuenta nada', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 10 });
      await api().patch(`/store/admin/products/${product.id}`).set(asAdmin()).send({ expectedVersion: 1, priceCents: 7500 });
      const response = await placeOrder(orderBody(product.id, {}, 1, 6999));
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ORDER_CONFLICT');
      expect(response.body.details.conflicts[0]).toMatchObject({ reason: 'price_changed', productId: product.id, currentPriceCents: 7500 });
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.stockQuantity).toBe(10);
      expect((await api().get('/store/orders').set(asCustomer())).body.total).toBe(0);
    });

    it('si no hay stock o el producto ya no está disponible, responde 409 con el detalle', async () => {
      const category = await newCategory();
      const scarce = await newProduct(category.id, { stock: 1 });
      const retired = await newProduct(category.id, { stock: 5 });
      await api().patch(`/store/admin/products/${retired.id}`).set(asAdmin()).send({ expectedVersion: 1, isActive: false });
      const stock = await placeOrder(orderBody(scarce.id, {}, 2));
      expect(stock.status).toBe(409);
      expect(stock.body.details.conflicts[0]).toMatchObject({ reason: 'insufficient_stock', available: 1 });
      const gone = await placeOrder(orderBody(retired.id));
      expect(gone.body.details.conflicts[0]).toMatchObject({ reason: 'unavailable' });
      const unknown = await placeOrder(orderBody(uuid()));
      expect(unknown.body.details.conflicts[0]).toMatchObject({ reason: 'unavailable' });
    });

    it('rechaza franjas inválidas, pasadas, llenas o de una zona inactiva, y zona inexistente', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 50 });
      const reason = async (overrides: Record<string, unknown>) => (await placeOrder(orderBody(product.id, overrides))).body.details?.conflicts?.[0]?.reason;
      expect(await reason({ deliveryTime: '07:00' })).toBe('slot_invalid');
      expect(await reason({ deliveryTime: '21:00' })).toBe('slot_invalid');
      expect(await reason({ deliveryDate: '2000-01-01' })).toBe('slot_unavailable');
      expect(await reason({ zoneId: h.inactiveZoneId })).toBe('zone_inactive');
      expect((await placeOrder(orderBody(product.id, { zoneId: h.missingZoneId }))).status).toBe(404);
      await api().put('/store/admin/settings').set(asAdmin()).send({ slotCapacity: 1, firstSlotHour: 8, lastSlotHour: 20, minLeadMinutes: 60 });
      expect((await placeOrder(orderBody(product.id, { deliveryTime: '15:00' }))).status).toBe(201);
      const full = await placeOrder(orderBody(product.id, { deliveryTime: '15:00' }), uuid(), h.otherCustomerToken);
      expect(full.status).toBe(409);
      expect(full.body.details.conflicts[0]).toMatchObject({ reason: 'slot_full', capacity: 1 });
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.stockQuantity).toBe(49);
    });

    it.each([
      ['un campo desconocido', { total: 1 }],
      ['dirección con emoji', { deliveryAddress: 'Calle \u{1F6B2} 123' }],
      ['dirección con keycap', { deliveryAddress: 'Calle 1️⃣ y Av. 5' }],
      ['dirección demasiado corta', { deliveryAddress: 'Av' }],
      ['fecha inexistente', { deliveryDate: '2026-02-31' }],
      ['fecha con otro formato', { deliveryDate: '15/10/2030' }],
      ['hora que no es en punto', { deliveryTime: '10:30' }],
      ['hora inválida', { deliveryTime: '25:00' }],
      ['zona que no es UUID', { zoneId: 'no-uuid' }],
      ['nombre de destinatario con números', { recipientName: 'Ana 123' }],
      ['teléfono inválido', { recipientPhone: 'abc' }],
      ['notas con emoji', { notes: 'Dejar en portería \u{1F44D}' }],
      ['lista de productos vacía', { items: [] }],
      ['productos que no son una lista', { items: { productId: uuid() } }],
    ])('rechaza un pedido con %s', async (_why, overrides) => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      const response = await placeOrder(orderBody(product.id, overrides));
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect((await api().get('/store/orders').set(asCustomer())).body.total).toBe(0);
    });

    it('rechaza líneas inválidas: repetidas, cantidad fuera de rango, precio inválido y demasiadas líneas', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 50 });
      const line = { productId: product.id, quantity: 1, unitPriceCents: 6999 };
      const statusFor = async (items: unknown) => (await placeOrder(orderBody(product.id, { items }))).status;
      expect(await statusFor([line, line])).toBe(400);
      expect(await statusFor([{ ...line, quantity: 0 }])).toBe(400);
      expect(await statusFor([{ ...line, quantity: 11 }])).toBe(400);
      expect(await statusFor([{ ...line, quantity: 1.5 }])).toBe(400);
      expect(await statusFor([{ ...line, unitPriceCents: 0 }])).toBe(400);
      expect(await statusFor([{ ...line, unitPriceCents: '6999' }])).toBe(400);
      expect(await statusFor([{ ...line, extra: true }])).toBe(400);
      expect(await statusFor([{ ...line, productId: 'no-uuid' }])).toBe(400);
      expect(await statusFor(Array.from({ length: 21 }, () => ({ ...line, productId: uuid() })))).toBe(400);
    });

    it('un pedido con varios productos suma el total y descuenta cada stock', async () => {
      const category = await newCategory();
      const a = await newProduct(category.id, { stock: 5, priceCents: 1000, compareAtPriceCents: null });
      const b = await newProduct(category.id, { stock: 5, priceCents: 2500, compareAtPriceCents: null });
      const response = await placeOrder(orderBody(a.id, {
        items: [{ productId: a.id, quantity: 2, unitPriceCents: 1000 }, { productId: b.id, quantity: 1, unitPriceCents: 2500 }],
        recipientName: 'María José Pérez', recipientPhone: '+593 99 123 4567', notes: 'Tocar el timbre dos veces.',
      }));
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ totalCents: 4500, itemsCount: 2, recipientName: 'María José Pérez', recipientPhone: '+593991234567' });
      expect((await api().get(`/store/admin/products/${a.id}`).set(asAdmin())).body.stockQuantity).toBe(3);
      expect((await api().get(`/store/admin/products/${b.id}`).set(asAdmin())).body.stockQuantity).toBe(4);
    });

    it('cada cliente ve solo sus pedidos; un pedido ajeno responde 404; el administrador ve todos', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 20 });
      const mine = (await placeOrder(orderBody(product.id))).body.id as string;
      const theirs = (await placeOrder(orderBody(product.id), uuid(), h.otherCustomerToken)).body.id as string;
      expect((await api().get('/store/orders').set(asCustomer())).body.total).toBe(1);
      expect((await api().get('/store/orders').set(bearer(h.otherCustomerToken))).body.total).toBe(1);
      expect((await api().get('/store/orders').set(asAdmin())).body.total).toBe(2);
      expect((await api().get(`/store/orders/${mine}`).set(asCustomer())).status).toBe(200);
      const foreign = await api().get(`/store/orders/${theirs}`).set(asCustomer());
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('ORDER_NOT_FOUND');
      expect((await api().get(`/store/orders/${theirs}`).set(asAdmin())).status).toBe(200);
      expect((await api().get('/store/orders/no-uuid').set(asCustomer())).status).toBe(400);
    });

    it('limita los pedidos por IP', async () => {
      h = await create({ storeRateLimit: { maxRequests: 3, windowMs: 60_000 } });
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 20 });
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await placeOrder(orderBody(product.id))).status);
      expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
      expect(statuses[3]).toBe(429);
    });
  });

  // ------------------------------------------------------------------------------------------- concurrencia por HTTP
  describe('Concurrencia por HTTP', () => {
    it('seis compradores a la vez por la última unidad: gana exactamente uno', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 1 });
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_unused, index) =>
          placeOrder(orderBody(product.id, { deliveryTime: `${String(10 + index)}:00` }), uuid(), index % 2 === 0 ? h.customerToken : h.otherCustomerToken)),
      );
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(5);
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.stockQuantity).toBe(0);
    });

    it('cuatro envíos simultáneos con la misma clave crean un solo pedido', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 10 });
      const key = uuid();
      const responses = await Promise.all(Array.from({ length: 4 }, () => placeOrder(orderBody(product.id, {}, 2), key)));
      expect(responses.every((response) => response.status === 201 || response.status === 200)).toBe(true);
      expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect((await api().get('/store/orders').set(asCustomer())).body.total).toBe(1);
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.stockQuantity).toBe(8);
    });

    it('el cupo de una franja no se sobrepasa con pedidos simultáneos', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 50 });
      await api().put('/store/admin/settings').set(asAdmin()).send({ slotCapacity: 2, firstSlotHour: 8, lastSlotHour: 20, minLeadMinutes: 60 });
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => placeOrder(orderBody(product.id, { deliveryTime: '16:00' }))),
      );
      expect(responses.filter((response) => response.status === 201)).toHaveLength(2);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(4);
    });

    it('compras y ajustes de stock a la vez dejan el stock exacto', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id, { stock: 20 });
      const operations: Array<Promise<{ status: number }>> = [];
      for (let i = 0; i < 5; i += 1) operations.push(placeOrder(orderBody(product.id, { deliveryTime: `${String(9 + i).padStart(2, '0')}:00` }, 2)));
      for (let i = 0; i < 3; i += 1) operations.push(api().post(`/store/admin/products/${product.id}/stock-adjustments`).set(asAdmin()).send({ delta: 4, reason: 'restock' }));
      const results = await Promise.all(operations);
      expect(results.every((result) => result.status === 201 || result.status === 200)).toBe(true);
      // 20 - (5 x 2) + (3 x 4) = 22
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.stockQuantity).toBe(22);
    });

    it('dos administradores editan a la vez con la misma versión: solo uno gana', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      const results = await Promise.all([
        api().patch(`/store/admin/products/${product.id}`).set(asAdmin()).send({ expectedVersion: 1, priceCents: 5000 }),
        api().patch(`/store/admin/products/${product.id}`).set(asAdmin()).send({ expectedVersion: 1, priceCents: 5100 }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect((await api().get(`/store/admin/products/${product.id}`).set(asAdmin())).body.version).toBe(2);
    });
  });

  // ------------------------------------------------------------------------------------------- imágenes
  describe('Imágenes de producto', () => {
    const upload = (productId: string, body: Buffer | string, contentType: string, version: number | string = 1, token = () => h.adminToken) =>
      api().put(`/store/admin/products/${productId}/image`).query({ expectedVersion: String(version) })
        .set(bearer(token())).set('Content-Type', contentType).send(body);

    it('sube una imagen, la sirve públicamente con caché larga y reemplazarla borra la anterior', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      const first = await upload(product.id, pngBytes(300, 200), 'image/png');
      expect(first.status).toBe(200);
      expect(first.body.version).toBe(2);
      expect(first.body.imageUrl).toMatch(/^\/store\/images\/[0-9a-f]{32}\.png$/);
      expect(h.images.size).toBe(1);

      // Pública: sin sesión, como una etiqueta <img>.
      const served = await api().get(first.body.imageUrl as string);
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.headers['cache-control']).toContain('immutable');
      expect(served.headers['content-security-policy']).toContain("default-src 'none'");
      expect(served.headers['x-content-type-options']).toBe('nosniff');

      // El cliente la ve en el catálogo.
      const listed = await api().get(`/store/products/${product.id}`).set(asCustomer());
      expect(listed.body.imageUrl).toBe(first.body.imageUrl);

      const second = await upload(product.id, pngBytes(640, 480), 'image/png', 2);
      expect(second.status).toBe(200);
      expect(second.body.imageUrl).not.toBe(first.body.imageUrl);
      expect(h.images.size).toBe(1);
      expect((await api().get(first.body.imageUrl as string)).status).toBe(404);

      const removed = await api().delete(`/store/admin/products/${product.id}/image`).query({ expectedVersion: '3' }).set(asAdmin());
      expect(removed.status).toBe(200);
      expect(removed.body.imageUrl).toBeNull();
      expect(h.images.size).toBe(0);
    });

    it('con una versión vieja responde 409 y no deja archivos huérfanos', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      const stale = await upload(product.id, pngBytes(300, 200), 'image/png', 9);
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(h.images.size).toBe(0);
    });

    it('rechaza lo que no es una imagen válida', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      expect((await upload(product.id, 'esto no es una imagen', 'text/plain')).status).toBe(415);
      expect((await upload(product.id, Buffer.from('MZ-ejecutable-disfrazado-de-png'), 'image/png')).status).toBe(415);
      expect((await upload(product.id, pngBytes(5000, 100), 'image/png')).status).toBe(400);
      expect((await upload(product.id, pngBytes(10, 10), 'image/png')).status).toBe(400);
      expect((await upload(product.id, Buffer.alloc(0), 'image/png')).status).toBe(400);
      const oversized = Buffer.concat([pngBytes(300, 200), Buffer.alloc(5 * 1024 * 1024)]);
      const big = await upload(product.id, oversized, 'image/png');
      expect(big.status).toBe(413);
      expect(big.body.code).toBe('FILE_TOO_LARGE');
      expect((await upload(product.id, pngBytes(300, 200), 'image/png', 'abc')).status).toBe(400);
      expect(h.images.size).toBe(0);
    });

    it('solo el administrador sube imágenes y el nombre de archivo se valida', async () => {
      const category = await newCategory();
      const product = await newProduct(category.id);
      expect((await upload(product.id, pngBytes(300, 200), 'image/png', 1, () => h.customerToken)).status).toBe(403);
      expect((await api().get('/store/images/..%2F..%2Fetc%2Fpasswd').set(asAdmin())).status).toBeGreaterThanOrEqual(400);
      expect((await api().get('/store/images/no-valido.png').set(asAdmin())).status).toBe(400);
    });
  });
}

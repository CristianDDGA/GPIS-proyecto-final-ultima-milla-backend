import request from 'supertest';
import { futureDate, type StoreHarness } from './store-api-suite.js';

// Suite HTTP de los flujos por rol (migración 011): cancelar, entrega fallida, cobro, caja, direcciones y reportes.
// Igual que la suite de la tienda, corre contra el repositorio en memoria y contra PostgreSQL real.

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const uuid = () => crypto.randomUUID();

export function defineStoreFlowsSuite(create: () => Promise<StoreHarness> | StoreHarness): void {
  let h: StoreHarness;
  beforeEach(async () => { h = await create(); });

  const api = () => request(h.app);
  const admin = () => bearer(h.adminToken);
  const customer = () => bearer(h.customerToken);
  const other = () => bearer(h.otherCustomerToken);
  const driver = () => bearer(h.driverToken);

  async function newProduct(stock = 10, priceCents = 6999, name = 'Audífonos inalámbricos serie 100') {
    const category = await api().post('/store/admin/categories').set(admin()).send({ name: `Categoría ${uuid().slice(0, 8)}` });
    expect(category.status).toBe(201);
    const product = await api().post('/store/admin/products').set(admin()).send({
      sku: `F-${uuid().slice(0, 8).toUpperCase()}`, name, categoryId: category.body.id, priceCents, stock,
    });
    expect(product.status).toBe(201);
    return product.body as { id: string; stockQuantity: number; version: number };
  }

  async function placeOrder(productId: string, quantity = 1, price = 6999, hour = '10:00', token: string = h.customerToken) {
    const response = await api().post('/store/orders').set(bearer(token)).set('Idempotency-Key', uuid()).send({
      zoneId: h.zoneId, deliveryAddress: 'Av. 9 de Octubre 123 y Malecón', deliveryDate: futureDate(3), deliveryTime: hour,
      items: [{ productId, quantity, unitPriceCents: price }],
    });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  const stockOf = async (productId: string): Promise<number> => {
    const response = await api().get(`/store/admin/products/${productId}`).set(admin());
    expect(response.status).toBe(200);
    return response.body.stockQuantity as number;
  };

  const orderOf = async (orderId: string) => {
    const response = await api().get(`/store/orders/${orderId}`).set(customer());
    expect(response.status).toBe(200);
    return response.body as { status: string };
  };

  const DEFAULT_CANCEL = { reason: 'cliente_desiste' };
  const cancel = (orderId: string, body?: object, token: string = h.customerToken) =>
    api().post(`/store/orders/${orderId}/cancel`).set(bearer(token)).send(body ?? DEFAULT_CANCEL);

  const courierList = async () => {
    const response = await api().get('/store/courier/orders').set(driver());
    expect(response.status).toBe(200);
    return response.body.items as Array<{ orderId: string; version: number; status: string; totalCents: number; failedAttempts: number; items: Array<{ name: string; quantity: number }> }>;
  };

  const deliver = (orderId: string, body: object, key: string = uuid()) =>
    api().post(`/store/courier/orders/${orderId}/deliver`).set(driver()).set('Idempotency-Key', key).send(body);

  const fail = (orderId: string, body: object, key: string = uuid()) =>
    api().post(`/store/courier/orders/${orderId}/fail`).set(driver()).set('Idempotency-Key', key).send(body);

  async function versionOf(orderId: string): Promise<number> {
    const found = (await courierList()).find((item) => item.orderId === orderId);
    if (!found) throw new Error('El pedido no está en la ruta del conductor.');
    return found.version;
  }

  /** Lleva un pedido pendiente hasta "en camino" con su propia ruta. */
  async function onTheWay(orderId: string): Promise<string> {
    const route = await h.dispatch.assign([orderId]);
    await h.dispatch.advance(orderId, 'recogido');
    await h.dispatch.advance(orderId, 'en_camino');
    return route;
  }

  // ------------------------------------------------------------------------------------------- seguimiento
  describe('Seguimiento del pedido (migración 015)', () => {
    type Tracked = { status: string; history: Array<{ status: string; at: string }>; courier: { firstName: string } | null };
    const tracked = async (orderId: string, token: string = h.customerToken): Promise<Tracked> => {
      const response = await api().get(`/store/orders/${orderId}`).set(bearer(token));
      expect(response.status).toBe(200);
      return response.body as Tracked;
    };

    it('muestra la hora de cada paso y el nombre de pila del repartidor solo mientras lleva el pedido', async () => {
      const product = await newProduct(10, 2500);
      const orderId = await placeOrder(product.id, 2, 2500);

      const placed = await tracked(orderId);
      expect(placed.history.map((event) => event.status)).toEqual(['pendiente']);
      expect(Number.isFinite(Date.parse(placed.history[0]?.at ?? ''))).toBe(true);
      expect(placed.courier).toBeNull();

      await onTheWay(orderId);
      const moving = await tracked(orderId);
      expect(moving.history.map((event) => event.status)).toEqual(['pendiente', 'asignado_a_ruta', 'recogido', 'en_camino']);
      const times = moving.history.map((event) => Date.parse(event.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(moving.courier).toEqual({ firstName: 'Conductor' });

      // El administrador ve lo mismo; otro cliente no ve el pedido.
      expect((await tracked(orderId, h.adminToken)).courier).toEqual({ firstName: 'Conductor' });
      expect((await api().get(`/store/orders/${orderId}`).set(other())).status).toBe(404);

      const version = await versionOf(orderId);
      expect((await deliver(orderId, { expectedVersion: version, collectedCents: 5000 })).status).toBe(200);
      const delivered = await tracked(orderId);
      expect(delivered.history.map((event) => event.status)).toEqual(['pendiente', 'asignado_a_ruta', 'recogido', 'en_camino', 'entregado']);
    });

    it('un pedido cancelado registra el paso de cancelación y no tiene repartidor', async () => {
      const product = await newProduct(10, 2500);
      const orderId = await placeOrder(product.id, 1, 2500);
      expect((await cancel(orderId)).status).toBe(200);
      const cancelled = await tracked(orderId);
      expect(cancelled.history.map((event) => event.status)).toEqual(['pendiente', 'cancelado']);
      expect(cancelled.courier).toBeNull();
    });

    it('el pedido recién creado ya trae su línea de tiempo', async () => {
      const product = await newProduct(10, 2500);
      const response = await api().post('/store/orders').set(customer()).set('Idempotency-Key', uuid()).send({
        zoneId: h.zoneId, deliveryAddress: 'Av. 9 de Octubre 123 y Malecón', deliveryDate: futureDate(3), deliveryTime: '11:00',
        items: [{ productId: product.id, quantity: 1, unitPriceCents: 2500 }],
      });
      expect(response.status).toBe(201);
      expect(response.body.history.map((event: { status: string }) => event.status)).toEqual(['pendiente']);
      expect(response.body.courier).toBeNull();
    });
  });

  // ------------------------------------------------------------------------------------------- cancelar
  describe('Cancelar un pedido', () => {
    it('el cliente cancela su pedido: devuelve el stock, libera la franja y es idempotente', async () => {
      const product = await newProduct(10);
      const orderId = await placeOrder(product.id, 3);
      expect(await stockOf(product.id)).toBe(7);

      const slotsBefore = await api().get('/store/delivery-slots').set(customer()).query({ zoneId: h.zoneId, date: futureDate(3) });
      const reservedBefore = slotsBefore.body.items.find((slot: { time: string }) => slot.time === '10:00').reserved;
      expect(reservedBefore).toBe(1);

      const response = await cancel(orderId, { reason: 'error_en_pedido', note: 'Me equivoqué de dirección' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'cancelado', alreadyCancelled: false, restocked: true });
      expect(response.body.order.status).toBe('cancelado');
      expect(await stockOf(product.id)).toBe(10);

      const slotsAfter = await api().get('/store/delivery-slots').set(customer()).query({ zoneId: h.zoneId, date: futureDate(3) });
      expect(slotsAfter.body.items.find((slot: { time: string }) => slot.time === '10:00').reserved).toBe(0);

      const again = await cancel(orderId);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ alreadyCancelled: true });
      expect(await stockOf(product.id)).toBe(10);
      expect(await h.notificationKinds(orderId)).toEqual(['order_confirmed', 'order_cancelled']);
    });

    it('solo el dueño o un administrador pueden cancelar; el motivo es obligatorio y cerrado', async () => {
      const product = await newProduct();
      const orderId = await placeOrder(product.id);
      expect((await cancel(orderId, { reason: 'cliente_desiste' }, h.otherCustomerToken)).status).toBe(404);
      expect((await cancel(orderId, { reason: 'cliente_desiste' }, h.driverToken)).status).toBe(403);
      expect((await api().post(`/store/orders/${orderId}/cancel`).send({ reason: 'otro' })).status).toBe(401);
      expect((await cancel(orderId, {})).status).toBe(400);
      expect((await cancel(orderId, { reason: 'porque_si' })).status).toBe(400);
      expect((await cancel(orderId, { reason: 'otro', extra: 1 })).status).toBe(400);
      expect((await cancel(orderId, { reason: 'otro', note: 'Nota con emoji 😀' })).status).toBe(400);
      expect((await cancel('no-es-uuid')).status).toBe(400);
      expect((await cancel(uuid())).status).toBe(404);
      expect(await stockOf(product.id)).toBe(9);

      const byAdmin = await cancel(orderId, { reason: 'sin_stock' }, h.adminToken);
      expect(byAdmin.status).toBe(200);
      expect(byAdmin.body.alreadyCancelled).toBe(false);
      expect(await stockOf(product.id)).toBe(10);
    });

    it('un pedido asignado a una ruta se puede cancelar y sale de la ruta del conductor', async () => {
      const product = await newProduct();
      const first = await placeOrder(product.id);
      const second = await placeOrder(product.id);
      await h.dispatch.assign([first, second]);
      expect((await courierList()).map((item) => item.orderId).sort((x, y) => x.localeCompare(y))).toEqual([first, second].sort((x, y) => x.localeCompare(y)));
      expect((await cancel(first)).status).toBe(200);
      expect((await courierList()).map((item) => item.orderId)).toEqual([second]);
      expect(await stockOf(product.id)).toBe(9);
    });

    it('un pedido recogido o en camino ya no se cancela', async () => {
      const product = await newProduct();
      const orderId = await placeOrder(product.id);
      await h.dispatch.assign([orderId]);
      await h.dispatch.advance(orderId, 'recogido');
      const picked = await cancel(orderId);
      expect(picked.status).toBe(409);
      expect(picked.body.code).toBe('ORDER_NOT_CANCELLABLE');
      await h.dispatch.advance(orderId, 'en_camino');
      expect((await cancel(orderId, { reason: 'demora' }, h.adminToken)).status).toBe(409);
      expect(await stockOf(product.id)).toBe(9);
    });

    it('dos cancelaciones simultáneas devuelven el stock una sola vez', async () => {
      const product = await newProduct(5);
      const orderId = await placeOrder(product.id, 2);
      const results = await Promise.all([cancel(orderId), cancel(orderId, { reason: 'demora' }, h.adminToken), cancel(orderId)]);
      expect(results.every((response) => response.status === 200)).toBe(true);
      expect(results.filter((response) => response.body.alreadyCancelled === false)).toHaveLength(1);
      expect(await stockOf(product.id)).toBe(5);
    });
  });

  // ------------------------------------------------------------------------------------------- conductor
  describe('Conductor: ruta, cobro y entrega fallida', () => {
    it('ve sus pedidos con productos y total; nadie más los ve', async () => {
      const product = await newProduct(10, 2500, 'Cable USB tipo C');
      const orderId = await placeOrder(product.id, 2, 2500);
      expect(await courierList()).toEqual([]);
      await h.dispatch.assign([orderId]);
      const [mine] = await courierList();
      expect(mine).toMatchObject({ orderId, status: 'asignado_a_ruta', totalCents: 5000, failedAttempts: 0 });
      expect(mine?.items).toEqual([expect.objectContaining({ name: 'Cable USB tipo C', quantity: 2, unitPriceCents: 2500, lineTotalCents: 5000 })]);
      expect((await api().get('/store/courier/orders').set(customer())).status).toBe(403);
      expect((await api().get('/store/courier/orders').set(admin())).status).toBe(403);
      expect((await api().get('/store/courier/orders')).status).toBe(401);
    });

    it('entrega con cobro exacto: registra el efectivo y es idempotente por clave', async () => {
      const product = await newProduct(10, 2500);
      const orderId = await placeOrder(product.id, 2, 2500);
      await onTheWay(orderId);
      const version = await versionOf(orderId);

      expect((await deliver(orderId, { expectedVersion: version, collectedCents: 4999 })).status).toBe(422);
      expect((await deliver(orderId, { expectedVersion: version, collectedCents: 0 })).status).toBe(400);
      expect((await deliver(orderId, { expectedVersion: version + 5, collectedCents: 5000 })).status).toBe(409);
      expect((await api().post(`/store/courier/orders/${orderId}/deliver`).set(driver()).send({ expectedVersion: version, collectedCents: 5000 })).status).toBe(400);
      expect((await api().post(`/store/courier/orders/${orderId}/deliver`).set(customer()).set('Idempotency-Key', uuid()).send({ expectedVersion: version, collectedCents: 5000 })).status).toBe(403);
      expect((await orderOf(orderId)).status).toBe('en_camino');

      const key = uuid();
      const done = await deliver(orderId, { expectedVersion: version, collectedCents: 5000 }, key);
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ orderId, status: 'entregado', collectedCents: 5000, replayed: false });

      const replay = await deliver(orderId, { expectedVersion: version, collectedCents: 5000 }, key);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toMatchObject({ status: 'entregado', replayed: true });
      expect((await deliver(orderId, { expectedVersion: version, collectedCents: 5001 }, key)).status).toBe(422);

      expect((await orderOf(orderId)).status).toBe('entregado');
      expect((await deliver(orderId, { expectedVersion: version, collectedCents: 5000 })).status).toBe(409);
      expect((await cancel(orderId)).status).toBe(409);
      expect(await h.notificationKinds(orderId)).toEqual(['order_confirmed', 'order_status', 'order_status']);
    });

    it('no puede entregar un pedido que no está en camino ni uno ajeno', async () => {
      const product = await newProduct(10, 1000);
      const orderId = await placeOrder(product.id, 1, 1000);
      const unassigned = await deliver(orderId, { expectedVersion: 1, collectedCents: 1000 });
      expect(unassigned.status).toBe(409);
      await h.dispatch.assign([orderId]);
      const version = await versionOf(orderId);
      expect((await deliver(orderId, { expectedVersion: version, collectedCents: 1000 })).status).toBe(409);
      expect((await orderOf(orderId)).status).toBe('asignado_a_ruta');
    });

    it('entrega fallida: motivo cerrado, intento contado y la ruta se cierra con la parada fallida', async () => {
      const product = await newProduct(10, 1000);
      const orderId = await placeOrder(product.id, 1, 1000);
      const route = await onTheWay(orderId);
      const version = await versionOf(orderId);

      expect((await fail(orderId, { expectedVersion: version })).status).toBe(400);
      expect((await fail(orderId, { expectedVersion: version, reason: 'no_quiso' })).status).toBe(400);
      expect((await fail(orderId, { expectedVersion: version + 3, reason: 'cliente_ausente' })).status).toBe(409);

      const key = uuid();
      const first = await fail(orderId, { expectedVersion: version, reason: 'cliente_ausente', note: 'Nadie abrió la puerta' }, key);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: 'entrega_fallida', attempt: 1, replayed: false });
      const replay = await fail(orderId, { expectedVersion: version, reason: 'cliente_ausente', note: 'Nadie abrió la puerta' }, key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.attempt).toBe(1);
      expect((await orderOf(orderId)).status).toBe('entrega_fallida');
      expect((await courierList())[0]?.failedAttempts).toBe(1);

      // Mientras la ruta siga abierta no se cancela ni se reprograma.
      expect((await cancel(orderId)).status).toBe(409);
      const early = await api().post(`/store/orders/${orderId}/reschedule`).set(customer()).send({ deliveryDate: futureDate(4), deliveryTime: '11:00' });
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('ORDER_NOT_RESCHEDULABLE');

      await h.dispatch.closeRoute(route);
      expect(await courierList()).toEqual([]);
    });

    it('reprograma tras la falla, vuelve a intentarse y al tercer intento solo queda cancelar', async () => {
      const product = await newProduct(10, 1000);
      const orderId = await placeOrder(product.id, 1, 1000);
      const reasons = ['cliente_ausente', 'direccion_incorrecta', 'zona_inaccesible'];

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const route = await onTheWay(orderId);
        const failed = await fail(orderId, { expectedVersion: await versionOf(orderId), reason: reasons[attempt - 1] });
        expect(failed.status).toBe(200);
        expect(failed.body.attempt).toBe(attempt);
        await h.dispatch.closeRoute(route);

        const slotSchedule = { deliveryDate: futureDate(3 + attempt), deliveryTime: '11:00' };
        if (attempt < 3) {
          const moved = await api().post(`/store/orders/${orderId}/reschedule`).set(customer()).send(slotSchedule);
          expect(moved.status).toBe(200);
          expect(moved.body).toMatchObject({ status: 'pendiente', deliveryDate: slotSchedule.deliveryDate, deliveryTime: '11:00' });
        } else {
          const blocked = await api().post(`/store/orders/${orderId}/reschedule`).set(customer()).send(slotSchedule);
          expect(blocked.status).toBe(409);
          expect(blocked.body.code).toBe('MAX_DELIVERY_ATTEMPTS');
        }
      }
      expect((await orderOf(orderId)).status).toBe('entrega_fallida');
      const cancelled = await cancel(orderId, { reason: 'no_localizable' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.restocked).toBe(true);
      expect(await stockOf(product.id)).toBe(10);
      expect(await h.notificationKinds(orderId)).toContain('order_rescheduled');
    });

    it('reprogramar valida franja, fecha y dueño', async () => {
      const product = await newProduct(10, 1000);
      const orderId = await placeOrder(product.id, 1, 1000);
      const route = await onTheWay(orderId);
      expect((await fail(orderId, { expectedVersion: await versionOf(orderId), reason: 'cliente_rechazo' })).status).toBe(200);
      await h.dispatch.closeRoute(route);

      const reschedule = (body: object, token: string = h.customerToken) =>
        api().post(`/store/orders/${orderId}/reschedule`).set(bearer(token)).send(body);
      expect((await reschedule({ deliveryDate: futureDate(4), deliveryTime: '11:30' })).status).toBe(400);
      expect((await reschedule({ deliveryDate: '2024-13-01', deliveryTime: '11:00' })).status).toBe(400);
      expect((await reschedule({ deliveryTime: '11:00' })).status).toBe(400);
      expect((await reschedule({ deliveryDate: futureDate(4), deliveryTime: '11:00' }, h.otherCustomerToken)).status).toBe(404);
      expect((await reschedule({ deliveryDate: futureDate(4), deliveryTime: '11:00' }, h.driverToken)).status).toBe(403);
      const hour = await reschedule({ deliveryDate: futureDate(4), deliveryTime: '03:00' });
      expect(hour.status).toBe(409);
      expect(hour.body).toMatchObject({ code: 'SCHEDULE_CONFLICT', details: { reason: 'slot_invalid' } });
      const past = await reschedule({ deliveryDate: futureDate(-2), deliveryTime: '11:00' });
      expect(past.status).toBe(400);

      const byAdmin = await reschedule({ deliveryDate: futureDate(5), deliveryTime: '12:00' }, h.adminToken);
      expect(byAdmin.status).toBe(200);
      expect(byAdmin.body.deliveryDate).toBe(futureDate(5));
    });

    it('reprogramar respeta el cupo de la franja', async () => {
      const settings = await api().put('/store/admin/settings').set(admin()).send({ slotCapacity: 1, firstSlotHour: 8, lastSlotHour: 20, minLeadMinutes: 60 });
      expect(settings.status).toBe(200);
      const product = await newProduct(10, 1000);
      const failedOrder = await placeOrder(product.id, 1, 1000, '10:00');
      const route = await onTheWay(failedOrder);
      expect((await fail(failedOrder, { expectedVersion: await versionOf(failedOrder), reason: 'otro' })).status).toBe(200);
      await h.dispatch.closeRoute(route);
      await placeOrder(product.id, 1, 1000, '15:00', h.otherCustomerToken);
      const full = await api().post(`/store/orders/${failedOrder}/reschedule`).set(customer()).send({ deliveryDate: futureDate(3), deliveryTime: '15:00' });
      expect(full.status).toBe(409);
      expect(full.body.details.reason).toBe('slot_full');
    });
  });

  // ------------------------------------------------------------------------------------------- caja
  describe('Caja del conductor', () => {
    async function deliverOne(price: number): Promise<string> {
      const product = await newProduct(10, price);
      const orderId = await placeOrder(product.id, 1, price);
      const route = await onTheWay(orderId);
      expect((await deliver(orderId, { expectedVersion: await versionOf(orderId), collectedCents: price })).status).toBe(200);
      // Un conductor solo puede tener una ruta activa: se cierra para poder asignarle la siguiente.
      await h.dispatch.closeRoute(route);
      return orderId;
    }

    it('el conductor ve lo cobrado y el administrador rinde la caja una sola vez', async () => {
      const today = futureDate(0);
      await deliverOne(1500);
      await deliverOne(2500);

      const mine = await api().get('/store/courier/cash').set(driver());
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ date: today, collectedCents: 4000, ordersCount: 2, settlement: null });
      const empty = await api().get('/store/courier/cash').set(driver()).query({ date: futureDate(-5) });
      expect(empty.body).toMatchObject({ collectedCents: 0, ordersCount: 0 });

      const board = await api().get('/store/admin/cash').set(admin()).query({ date: today });
      expect(board.status).toBe(200);
      expect(board.body.items).toEqual([expect.objectContaining({ courierUserId: h.driverUserId, collectedCents: 4000, ordersCount: 2, settlement: null })]);

      const body = { courierUserId: h.driverUserId, date: today, receivedCents: 3900, note: 'Faltan 1 dólar' };
      expect((await api().post('/store/admin/cash/settlements').set(driver()).send(body)).status).toBe(403);
      expect((await api().post('/store/admin/cash/settlements').set(customer()).send(body)).status).toBe(403);
      expect((await api().post('/store/admin/cash/settlements').set(admin()).send({ ...body, receivedCents: -1 })).status).toBe(400);
      expect((await api().post('/store/admin/cash/settlements').set(admin()).send({ ...body, date: 'ayer' })).status).toBe(400);

      const settled = await api().post('/store/admin/cash/settlements').set(admin()).send(body);
      expect(settled.status).toBe(201);
      expect(settled.body).toEqual({ expectedCents: 4000, receivedCents: 3900, differenceCents: -100 });
      const twice = await api().post('/store/admin/cash/settlements').set(admin()).send(body);
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('ALREADY_SETTLED');

      const after = await api().get('/store/courier/cash').set(driver());
      expect(after.body.settlement).toMatchObject({ receivedCents: 3900, differenceCents: -100 });
    });

    it('no se rinde una caja vacía ni de un conductor inexistente', async () => {
      const today = futureDate(0);
      const nothing = await api().post('/store/admin/cash/settlements').set(admin()).send({ courierUserId: h.driverUserId, date: today, receivedCents: 0 });
      expect(nothing.status).toBe(409);
      expect(nothing.body.code).toBe('NOTHING_TO_SETTLE');
      const missing = await api().post('/store/admin/cash/settlements').set(admin()).send({ courierUserId: uuid(), date: today, receivedCents: 0 });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('COURIER_NOT_FOUND');
      expect((await api().get('/store/admin/cash').set(customer())).status).toBe(403);
      expect((await api().get('/store/courier/cash').set(admin())).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------- direcciones
  describe('Libreta de direcciones', () => {
    const base = () => ({ label: 'Casa', zoneId: h.zoneId, address: 'Av. 9 de Octubre 123 y Malecón' });
    const addAddress = (body: object, token: string = h.customerToken) => api().post('/store/addresses').set(bearer(token)).send(body);

    it('crea, lista, edita y borra; la primera es la predeterminada', async () => {
      const first = await addAddress({ ...base(), recipientName: 'Ana Pérez', recipientPhone: '0987654321' });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ label: 'Casa', isDefault: true, version: 1, recipientName: 'Ana Pérez', recipientPhone: '0987654321' });
      const second = await addAddress({ ...base(), label: 'Trabajo', address: 'Calle Mejía 55 y Sucre' });
      expect(second.body.isDefault).toBe(false);

      const list = await api().get('/store/addresses').set(customer());
      expect(list.body.items.map((item: { label: string }) => item.label)).toEqual(['Casa', 'Trabajo']);

      const promoted = await api().patch(`/store/addresses/${second.body.id}`).set(customer()).send({ expectedVersion: 1, isDefault: true });
      expect(promoted.status).toBe(200);
      expect(promoted.body).toMatchObject({ isDefault: true, version: 2 });
      const afterPromotion = await api().get('/store/addresses').set(customer());
      expect(afterPromotion.body.items.map((item: { label: string; isDefault: boolean }) => [item.label, item.isDefault])).toEqual([['Trabajo', true], ['Casa', false]]);

      const stale = await api().patch(`/store/addresses/${second.body.id}`).set(customer()).send({ expectedVersion: 1, label: 'Oficina' });
      expect(stale.status).toBe(409);
      const renamed = await api().patch(`/store/addresses/${second.body.id}`).set(customer()).send({ expectedVersion: 2, label: 'Oficina', recipientName: null });
      expect(renamed.body).toMatchObject({ label: 'Oficina', version: 3, recipientName: null });
      const noDefault = await api().patch(`/store/addresses/${second.body.id}`).set(customer()).send({ expectedVersion: 3, isDefault: false });
      expect(noDefault.status).toBe(400);

      expect((await api().delete(`/store/addresses/${second.body.id}`).set(customer())).status).toBe(204);
      const remaining = await api().get('/store/addresses').set(customer());
      expect(remaining.body.items).toEqual([expect.objectContaining({ label: 'Casa', isDefault: true })]);
      expect((await api().delete(`/store/addresses/${second.body.id}`).set(customer())).status).toBe(404);
    });

    it('rechaza nombres repetidos, emojis, teléfonos y zonas inválidas', async () => {
      expect((await addAddress(base())).status).toBe(201);
      const duplicate = await addAddress({ ...base(), label: 'CASA' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('DUPLICATE_ADDRESS');
      expect((await addAddress({ ...base(), label: 'Casa 😀' })).status).toBe(400);
      expect((await addAddress({ ...base(), label: 'X' })).status).toBe(400);
      expect((await addAddress({ ...base(), label: 'Playa', address: 'Calle 😀 55' })).status).toBe(400);
      expect((await addAddress({ ...base(), label: 'Playa', recipientPhone: 'abc' })).status).toBe(400);
      expect((await addAddress({ ...base(), label: 'Playa', recipientName: 'Ana 123' })).status).toBe(400);
      expect((await addAddress({ ...base(), label: 'Playa', zoneId: 'no-uuid' })).status).toBe(400);
      expect((await addAddress({ ...base(), label: 'Playa', extra: true })).status).toBe(400);
      expect((await addAddress({ ...base(), label: 'Playa', zoneId: h.inactiveZoneId })).status).toBe(404);
      expect((await addAddress({ ...base(), label: 'Playa', zoneId: h.missingZoneId })).status).toBe(404);
    });

    it('permite como máximo 10 direcciones por cliente', async () => {
      for (let index = 0; index < 10; index += 1) expect((await addAddress({ ...base(), label: `Lugar ${index + 1}` })).status).toBe(201);
      const eleventh = await addAddress({ ...base(), label: 'Lugar 11' });
      expect(eleventh.status).toBe(409);
      expect(eleventh.body.code).toBe('ADDRESS_LIMIT');
      expect((await addAddress({ ...base(), label: 'Lugar 1' }, h.otherCustomerToken)).status).toBe(201);
    });

    it('cada cliente solo toca las suyas y los demás roles no entran', async () => {
      const mine = await addAddress(base());
      expect((await api().get('/store/addresses').set(other())).body.items).toEqual([]);
      expect((await api().patch(`/store/addresses/${mine.body.id}`).set(other()).send({ expectedVersion: 1, label: 'Robada' })).status).toBe(404);
      expect((await api().delete(`/store/addresses/${mine.body.id}`).set(other())).status).toBe(404);
      for (const token of [h.adminToken, h.driverToken]) {
        expect((await api().get('/store/addresses').set(bearer(token))).status).toBe(403);
        expect((await api().post('/store/addresses').set(bearer(token)).send(base())).status).toBe(403);
      }
      expect((await api().get('/store/addresses')).status).toBe(401);
      expect((await api().get('/store/addresses').set(customer())).body.items).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------- administrador
  describe('Administrador: despacho, stock bajo y resumen', () => {
    it('lista los pedidos de la tienda con filtros y, si se pide, con sus productos', async () => {
      const product = await newProduct(10, 1200, 'Mouse inalámbrico 24');
      const kept = await placeOrder(product.id, 2, 1200);
      const dropped = await placeOrder(product.id, 1, 1200, '11:00');
      expect((await cancel(dropped)).status).toBe(200);

      const all = await api().get('/store/admin/orders').set(admin());
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(2);
      expect(all.body.items[0]).not.toHaveProperty('items');
      const open = await api().get('/store/admin/orders').set(admin()).query({ status: 'pendiente', expand: 'items' });
      expect(open.body.items).toHaveLength(1);
      expect(open.body.items[0]).toMatchObject({ id: kept, status: 'pendiente', totalCents: 2400 });
      expect(open.body.items[0].items).toEqual([expect.objectContaining({ name: 'Mouse inalámbrico 24', quantity: 2 })]);
      expect((await api().get('/store/admin/orders').set(admin()).query({ status: 'cancelado' })).body.total).toBe(1);
      expect((await api().get('/store/admin/orders').set(admin()).query({ deliveryDate: futureDate(9) })).body.total).toBe(0);
      expect((await api().get('/store/admin/orders').set(admin()).query({ zoneId: h.zoneId })).body.total).toBe(2);
      expect((await api().get('/store/admin/orders').set(admin()).query({ status: 'inventado' })).status).toBe(400);
      expect((await api().get('/store/admin/orders').set(admin()).query({ expand: 'todo' })).status).toBe(400);
      expect((await api().get('/store/admin/orders').set(customer())).status).toBe(403);
      expect((await api().get('/store/admin/orders').set(driver())).status).toBe(403);
    });

    it('avisa de productos con stock bajo', async () => {
      const scarce = await newProduct(2, 1000, 'Cargador rápido 20');
      await newProduct(40, 1000, 'Funda de silicona');
      const response = await api().get('/store/admin/low-stock').set(admin()).query({ threshold: 5 });
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([expect.objectContaining({ id: scarce.id, stockQuantity: 2 })]);
      expect((await api().get('/store/admin/low-stock').set(admin()).query({ threshold: -1 })).status).toBe(400);
      expect((await api().get('/store/admin/low-stock').set(customer())).status).toBe(403);
    });

    it('resume ventas, cancelaciones, fallas y cobros del rango', async () => {
      const product = await newProduct(20, 1000, 'Teclado compacto 60');
      const delivered = await placeOrder(product.id, 3, 1000);
      const cancelled = await placeOrder(product.id, 1, 1000, '11:00');
      const failed = await placeOrder(product.id, 1, 1000, '12:00');
      expect((await cancel(cancelled, { reason: 'demora' })).status).toBe(200);

      const route = await h.dispatch.assign([delivered, failed]);
      for (const id of [delivered, failed]) {
        await h.dispatch.advance(id, 'recogido');
        await h.dispatch.advance(id, 'en_camino');
      }
      expect((await deliver(delivered, { expectedVersion: await versionOf(delivered), collectedCents: 3000 })).status).toBe(200);
      expect((await fail(failed, { expectedVersion: await versionOf(failed), reason: 'cliente_ausente' })).status).toBe(200);
      await h.dispatch.closeRoute(route);

      const summary = await api().get('/store/admin/summary').set(admin()).query({ from: futureDate(0), to: futureDate(3) });
      expect(summary.status).toBe(200);
      expect(summary.body.orders.total).toBe(3);
      expect(summary.body.orders.byStatus).toEqual({ entregado: 1, cancelado: 1, entrega_fallida: 1 });
      expect(summary.body.grossCents).toBe(4000);
      expect(summary.body.collectedCents).toBe(3000);
      expect(summary.body.cancellations).toEqual({ count: 1, byReason: { demora: 1 } });
      expect(summary.body.failures).toEqual({ count: 1, byReason: { cliente_ausente: 1 } });
      expect(summary.body.topProducts[0]).toMatchObject({ name: 'Teclado compacto 60', units: 4, revenueCents: 4000 });

      expect((await api().get('/store/admin/summary').set(admin()).query({ from: futureDate(3), to: futureDate(0) })).status).toBe(400);
      expect((await api().get('/store/admin/summary').set(admin()).query({ from: 'hoy' })).status).toBe(400);
      expect((await api().get('/store/admin/summary').set(customer())).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------- avisos
  describe('Avisos por correo al cliente', () => {
    it('deja un aviso por cada cambio relevante y ninguno por pasos internos', async () => {
      const product = await newProduct(10, 1000);
      const orderId = await placeOrder(product.id, 1, 1000);
      expect(await h.notificationKinds(orderId)).toEqual(['order_confirmed']);
      await h.dispatch.assign([orderId]);
      await h.dispatch.advance(orderId, 'recogido');
      expect(await h.notificationKinds(orderId)).toEqual(['order_confirmed']);
      await h.dispatch.advance(orderId, 'en_camino');
      expect(await h.notificationKinds(orderId)).toEqual(['order_confirmed', 'order_status']);
    });
  });
}

// Las pruebas de coordenadas viven en su propia función para no alargar la suite principal.
export function defineStoreCoordinatesSuite(create: () => Promise<StoreHarness> | StoreHarness): void {
  let h: StoreHarness;
  beforeEach(async () => { h = await create(); });

  const api = () => request(h.app);
  const admin = () => bearer(h.adminToken);
  const customer = () => bearer(h.customerToken);
  const driver = () => bearer(h.driverToken);

  async function newProduct(): Promise<{ id: string }> {
    const category = await api().post('/store/admin/categories').set(admin()).send({ name: `Mapa ${uuid().slice(0, 8)}` });
    const product = await api().post('/store/admin/products').set(admin()).send({
      sku: `M-${uuid().slice(0, 8).toUpperCase()}`, name: 'Producto con mapa 1', categoryId: category.body.id, priceCents: 1500, stock: 10,
    });
    expect(product.status).toBe(201);
    return product.body as { id: string };
  }

  const orderBody = (productId: string, extra: Record<string, unknown> = {}) => ({
    zoneId: h.zoneId, deliveryAddress: 'Av. Amazonas 123 y Naciones Unidas', deliveryDate: futureDate(3), deliveryTime: '10:00',
    items: [{ productId, quantity: 1, unitPriceCents: 1500 }], ...extra,
  });
  const place = (body: object, key: string = uuid()) => api().post('/store/orders').set(customer()).set('Idempotency-Key', key).send(body);

  describe('Mapa y coordenadas', () => {
    it('un pedido con pin guarda el punto; sin pin sigue siendo válido y lo devuelve en null', async () => {
      const product = await newProduct();
      const manual = await place(orderBody(product.id));
      expect(manual.status).toBe(201);
      expect(manual.body).toMatchObject({ deliveryLatitude: null, deliveryLongitude: null });

      const pinned = await place(orderBody(product.id, { deliveryTime: '11:00', latitude: -0.1807, longitude: -78.4678 }));
      expect(pinned.status).toBe(201);
      expect(pinned.body).toMatchObject({ deliveryLatitude: -0.1807, deliveryLongitude: -78.4678 });
      const read = await api().get(`/store/orders/${pinned.body.id}`).set(customer());
      expect(read.body).toMatchObject({ deliveryLatitude: -0.1807, deliveryLongitude: -78.4678 });
      const list = await api().get('/store/orders').set(customer());
      expect(list.body.items.some((order: { deliveryLatitude: number | null }) => order.deliveryLatitude !== null && Math.abs(order.deliveryLatitude + 0.1807) < 1e-9)).toBe(true);
    });

    it('rechaza coordenadas incompletas, mal tipadas o fuera de Ecuador', async () => {
      const product = await newProduct();
      for (const extra of [
        { latitude: -0.18 }, { longitude: -78.4 }, { latitude: '-0.18', longitude: '-78.4' },
        { latitude: 40.4, longitude: -3.7 }, { latitude: -0.18, longitude: -60 }, { latitude: null, longitude: -78.4 },
      ]) {
        const response = await place(orderBody(product.id, extra));
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
      }
    });

    it('la misma Idempotency-Key con otro pin no se acepta, y con el mismo pin repite el pedido', async () => {
      const product = await newProduct();
      const key = uuid();
      const first = await place(orderBody(product.id, { latitude: -0.18, longitude: -78.47 }), key);
      expect(first.status).toBe(201);
      const same = await place(orderBody(product.id, { latitude: -0.18, longitude: -78.47 }), key);
      expect(same.status).toBe(200);
      expect(same.body.id).toBe(first.body.id);
      const other = await place(orderBody(product.id, { latitude: -0.2, longitude: -78.5 }), key);
      expect(other.status).toBe(422);
      expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('la libreta guarda, cambia y quita el pin de una dirección', async () => {
      const base = { label: 'Casa', zoneId: h.zoneId, address: 'Av. 9 de Octubre 123 y Malecón' };
      const manual = await api().post('/store/addresses').set(customer()).send(base);
      expect(manual.status).toBe(201);
      expect(manual.body).toMatchObject({ latitude: null, longitude: null });
      const pinned = await api().post('/store/addresses').set(customer()).send({ ...base, label: 'Trabajo', latitude: -2.1894, longitude: -79.8891 });
      expect(pinned.status).toBe(201);
      expect(pinned.body).toMatchObject({ latitude: -2.1894, longitude: -79.8891 });

      const moved = await api().patch(`/store/addresses/${manual.body.id}`).set(customer()).send({ expectedVersion: 1, latitude: -0.2, longitude: -78.5 });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ latitude: -0.2, longitude: -78.5 });
      const half = await api().patch(`/store/addresses/${manual.body.id}`).set(customer()).send({ expectedVersion: moved.body.version, latitude: -0.3 });
      expect(half.status).toBe(400);
      const cleared = await api().patch(`/store/addresses/${manual.body.id}`).set(customer()).send({ expectedVersion: moved.body.version, latitude: null, longitude: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ latitude: null, longitude: null });
      const outside = await api().post('/store/addresses').set(customer()).send({ ...base, label: 'Madrid', latitude: 40.4, longitude: -3.7 });
      expect(outside.status).toBe(400);
      const list = await api().get('/store/addresses').set(customer());
      expect(list.body.items.find((item: { label: string }) => item.label === 'Trabajo')).toMatchObject({ latitude: -2.1894, longitude: -79.8891 });
    });

    it('el conductor y el administrador ven el destino en el mapa', async () => {
      const product = await newProduct();
      const pinned = await place(orderBody(product.id, { latitude: -0.1807, longitude: -78.4678 }));
      const manual = await place(orderBody(product.id, { deliveryTime: '12:00' }));
      await h.dispatch.assign([pinned.body.id, manual.body.id]);
      const route = await api().get('/store/courier/orders').set(driver());
      expect(route.status).toBe(200);
      const byId = new Map<string, { deliveryLatitude: number | null; deliveryLongitude: number | null }>(
        route.body.items.map((item: { orderId: string; deliveryLatitude: number | null; deliveryLongitude: number | null }) => [item.orderId, item]),
      );
      expect(byId.get(pinned.body.id)).toMatchObject({ deliveryLatitude: -0.1807, deliveryLongitude: -78.4678 });
      expect(byId.get(manual.body.id)).toMatchObject({ deliveryLatitude: null, deliveryLongitude: null });

      const board = await api().get('/store/admin/orders').set(admin());
      expect(board.status).toBe(200);
      const found = board.body.items.find((order: { id: string }) => order.id === pinned.body.id);
      expect(found).toMatchObject({ deliveryLatitude: -0.1807, deliveryLongitude: -78.4678 });
    });
  });
}

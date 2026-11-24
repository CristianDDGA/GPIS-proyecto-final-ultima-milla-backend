import { randomBytes } from 'node:crypto';
import { detectImageType, readImageSize, type ImageType } from '../../../shared/image-type.js';
import type { AppRole } from '../../auth/domain/auth-user.entity.js';
import { StoreError } from '../domain/store.errors.js';
import {
  bodyObject,
  parseCategoryPatch,
  parseDeliverySlotsQuery,
  parseNewCategory,
  parseNewProduct,
  parsePaging,
  parsePlaceOrder,
  parseProductFilter,
  parseProductPatch,
  parseSettings,
  parseStockAdjustment,
  validateImageKey,
  validateUuid,
} from '../domain/store.validation.js';
import type { OrderConflict, Product, StoreOrderLine } from '../domain/store.types.js';
import type { CatalogRepository, ProductImageStorage, StoreOrderRepository } from './ports/store.ports.js';
import type { ZoneDeliveryGuard } from '../../../shared/zone-delivery-guard.port.js';

export interface StoreActor {
  readonly id: string;
  readonly role: AppRole;
}

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 4096;
const MIN_IMAGE_SIDE = 64;
const LOW_STOCK_THRESHOLD = 5;

export type Availability = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface FileContent {
  readonly bytes: Uint8Array;
  readonly contentType: ImageType;
}

const CONFLICT_MESSAGES: Record<OrderConflict['reason'], string> = {
  unavailable: 'Uno de los productos ya no está disponible.',
  price_changed: 'El precio de uno de los productos cambió. Revisa el carrito.',
  insufficient_stock: 'No hay stock suficiente de uno de los productos.',
  slot_invalid: 'La franja de entrega elegida no es válida.',
  slot_unavailable: 'La franja de entrega elegida ya no está disponible. Elige otra.',
  slot_full: 'La franja de entrega elegida se llenó. Elige otra.',
  zone_inactive: 'La zona de entrega no está disponible.',
};

/** Casos de uso de la tienda: catálogo, administración, franjas y pedidos. Aquí se decide quién puede hacer qué. */
export class StoreUseCases {
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly orders: StoreOrderRepository,
    private readonly images: ProductImageStorage,
    private readonly zoneGuard: ZoneDeliveryGuard,
  ) {}

  // ------------------------------------------------------------------------------------------ vistas

  private imageUrl(key: string | null): string | null {
    if (key === null) return null;
    return this.images.publicUrl(key) ?? `/store/images/${key}`;
  }

  /** Lo que ve un cliente: sin versión, sin estado interno y con el stock exacto solo cuando queda poco. */
  private customerView(product: Product) {
    const availability: Availability =
      product.stockQuantity <= 0 ? 'out_of_stock' : product.stockQuantity <= LOW_STOCK_THRESHOLD ? 'low_stock' : 'in_stock';
    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      description: product.description,
      category: product.category,
      priceCents: product.priceCents,
      compareAtPriceCents: product.compareAtPriceCents,
      discountPercent: product.discountPercent,
      availability,
      lowStockRemaining: availability === 'low_stock' ? product.stockQuantity : null,
      imageUrl: this.imageUrl(product.imageKey),
    };
  }

  private adminView(product: Product) {
    const { imageKey, ...rest } = product;
    return { ...rest, imageUrl: this.imageUrl(imageKey) };
  }

  private orderLine(line: StoreOrderLine) {
    const { imageKey, ...rest } = line;
    return { ...rest, imageUrl: this.imageUrl(imageKey) };
  }

  private static requireAdmin(actor: StoreActor): void {
    if (actor.role !== 'personal') throw new StoreError('FORBIDDEN');
  }

  // ------------------------------------------------------------------------------------------ catálogo (cliente y administrador)

  async listCategories(_actor: StoreActor) {
    return { items: await this.catalog.listCategories(false) };
  }

  async listProducts(_actor: StoreActor, query: Record<string, unknown>) {
    const filter = parseProductFilter(query, 'active', false);
    const page = await this.catalog.listProducts({ ...filter, status: 'active' });
    return { ...page, items: page.items.map((product) => this.customerView(product)) };
  }

  async getProduct(_actor: StoreActor, id: unknown) {
    const product = await this.catalog.getProduct(validateUuid(id, 'El producto'), false);
    if (product === null) throw new StoreError('PRODUCT_NOT_FOUND');
    return this.customerView(product);
  }

  async deliverySlots(_actor: StoreActor, query: Record<string, unknown>) {
    const { zoneId, date } = parseDeliverySlotsQuery(query);
    const slots = await this.orders.deliverySlots(zoneId, date);
    if (slots === null) throw new StoreError('ZONE_NOT_FOUND');
    return { zoneId, date, items: slots };
  }

  // ------------------------------------------------------------------------------------------ imágenes (lectura pública)

  async readImage(key: unknown): Promise<FileContent> {
    const valid = validateImageKey(key);
    const bytes = await this.images.read(valid);
    if (bytes === null) throw new StoreError('IMAGE_NOT_FOUND');
    return { bytes, contentType: valid.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }

  /** URL pública directa si el almacén la tiene (Supabase), para redirigir en vez de transmitir los bytes. */
  publicImageUrl(key: string): string | null {
    return this.images.publicUrl(key);
  }

  // ------------------------------------------------------------------------------------------ administración

  async adminListCategories(actor: StoreActor) {
    StoreUseCases.requireAdmin(actor);
    return { items: await this.catalog.listCategories(true) };
  }

  async adminCreateCategory(actor: StoreActor, body: unknown) {
    StoreUseCases.requireAdmin(actor);
    return this.catalog.createCategory(parseNewCategory(bodyObject(body)), actor.id);
  }

  async adminUpdateCategory(actor: StoreActor, id: unknown, body: unknown) {
    StoreUseCases.requireAdmin(actor);
    const { expectedVersion, ...patch } = parseCategoryPatch(bodyObject(body));
    return this.catalog.updateCategory(validateUuid(id, 'La categoría'), patch, expectedVersion, actor.id);
  }

  async adminListProducts(actor: StoreActor, query: Record<string, unknown>) {
    StoreUseCases.requireAdmin(actor);
    const page = await this.catalog.listProducts(parseProductFilter(query, 'all', true));
    return { ...page, items: page.items.map((product) => this.adminView(product)) };
  }

  async adminGetProduct(actor: StoreActor, id: unknown) {
    StoreUseCases.requireAdmin(actor);
    const product = await this.catalog.getProduct(validateUuid(id, 'El producto'), true);
    if (product === null) throw new StoreError('PRODUCT_NOT_FOUND');
    return this.adminView(product);
  }

  async adminCreateProduct(actor: StoreActor, body: unknown) {
    StoreUseCases.requireAdmin(actor);
    return this.adminView(await this.catalog.createProduct(parseNewProduct(bodyObject(body)), actor.id));
  }

  async adminUpdateProduct(actor: StoreActor, id: unknown, body: unknown) {
    StoreUseCases.requireAdmin(actor);
    const { patch, expectedVersion } = parseProductPatch(bodyObject(body));
    return this.adminView(await this.catalog.updateProduct(validateUuid(id, 'El producto'), patch, expectedVersion, actor.id));
  }

  async adminAdjustStock(actor: StoreActor, id: unknown, body: unknown) {
    StoreUseCases.requireAdmin(actor);
    const { delta, reason } = parseStockAdjustment(bodyObject(body));
    return this.catalog.adjustStock(validateUuid(id, 'El producto'), delta, reason, actor.id);
  }

  async adminProductEvents(actor: StoreActor, id: unknown) {
    StoreUseCases.requireAdmin(actor);
    return { items: await this.catalog.listProductEvents(validateUuid(id, 'El producto'), 100) };
  }

  async adminGetSettings(actor: StoreActor) {
    StoreUseCases.requireAdmin(actor);
    return this.catalog.getSettings();
  }

  async adminUpdateSettings(actor: StoreActor, body: unknown) {
    StoreUseCases.requireAdmin(actor);
    return this.catalog.updateSettings(parseSettings(bodyObject(body)), actor.id);
  }

  /**
   * Sube la imagen de un producto. Orden seguro: valida los bytes, guarda el archivo nuevo, actualiza el producto
   * con control de versión y, solo si todo salió bien, borra el archivo anterior. Si la actualización falla, el
   * archivo nuevo se elimina para no dejar huérfanos.
   */
  async adminUploadImage(actor: StoreActor, id: unknown, expectedVersion: unknown, bytes: Uint8Array) {
    StoreUseCases.requireAdmin(actor);
    const productId = validateUuid(id, 'El producto');
    const version = Number(expectedVersion);
    if (typeof expectedVersion !== 'string' || !/^\d{1,15}$/.test(expectedVersion) || version < 1) {
      throw new StoreError('VALIDATION_ERROR', 'expectedVersion es obligatorio y debe ser un entero positivo.');
    }
    if (bytes.length === 0) throw new StoreError('VALIDATION_ERROR', 'La imagen está vacía.');
    if (bytes.length > MAX_PRODUCT_IMAGE_BYTES) throw new StoreError('FILE_TOO_LARGE', 'La imagen supera el límite de 5 MB.');
    const type = detectImageType(bytes);
    if (type === null) throw new StoreError('UNSUPPORTED_MEDIA_TYPE');
    const size = readImageSize(bytes, type);
    if (size === null) throw new StoreError('VALIDATION_ERROR', 'La imagen está dañada o su cabecera no es válida.');
    if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) {
      throw new StoreError('VALIDATION_ERROR', `La imagen no puede superar ${MAX_IMAGE_SIDE} x ${MAX_IMAGE_SIDE} píxeles.`);
    }
    if (size.width < MIN_IMAGE_SIDE || size.height < MIN_IMAGE_SIDE) {
      throw new StoreError('VALIDATION_ERROR', `La imagen debe medir al menos ${MIN_IMAGE_SIDE} x ${MIN_IMAGE_SIDE} píxeles.`);
    }

    const current = await this.catalog.getProduct(productId, true);
    if (current === null) throw new StoreError('PRODUCT_NOT_FOUND');

    const key = `${randomBytes(16).toString('hex')}.${type === 'image/png' ? 'png' : 'jpg'}`;
    await this.images.save(key, bytes);
    let updated: Product;
    try {
      updated = await this.catalog.updateProduct(productId, { imageKey: key }, version, actor.id);
    } catch (error: unknown) {
      await this.images.delete(key).catch(() => undefined);
      throw error;
    }
    if (current.imageKey !== null) await this.images.delete(current.imageKey).catch(() => undefined);
    return this.adminView(updated);
  }

  async adminRemoveImage(actor: StoreActor, id: unknown, expectedVersion: unknown) {
    StoreUseCases.requireAdmin(actor);
    const productId = validateUuid(id, 'El producto');
    const version = Number(expectedVersion);
    if (typeof expectedVersion !== 'string' || !/^\d{1,15}$/.test(expectedVersion) || version < 1) {
      throw new StoreError('VALIDATION_ERROR', 'expectedVersion es obligatorio y debe ser un entero positivo.');
    }
    const current = await this.catalog.getProduct(productId, true);
    if (current === null) throw new StoreError('PRODUCT_NOT_FOUND');
    const updated = await this.catalog.updateProduct(productId, { imageKey: null }, version, actor.id);
    if (current.imageKey !== null) await this.images.delete(current.imageKey).catch(() => undefined);
    return this.adminView(updated);
  }

  // ------------------------------------------------------------------------------------------ pedidos

  /** Solo los clientes compran. Devuelve el pedido y si es un reintento de uno ya creado (misma Idempotency-Key). */
  async placeOrder(actor: StoreActor, body: unknown, idempotencyKey: unknown) {
    if (actor.role !== 'cliente') throw new StoreError('FORBIDDEN', 'Solo los clientes pueden hacer pedidos de la tienda.');
    const command = parsePlaceOrder(bodyObject(body), idempotencyKey, actor.id);
    // La zona debe tener cobertura y el punto del mapa debe caer dentro de ella: lo decide el servidor, no la pantalla.
    const issue = await this.zoneGuard.check(command.zoneId, { latitude: command.latitude, longitude: command.longitude });
    if (issue !== null) throw new StoreError(issue);
    const result = await this.orders.placeOrder(command);
    if (result.status === 'conflict') {
      const first = result.conflicts[0];
      throw new StoreError('ORDER_CONFLICT', first ? CONFLICT_MESSAGES[first.reason] : undefined, { conflicts: result.conflicts });
    }
    const order = await this.orders.getOrder(result.orderId, { customerId: actor.id });
    if (order === null) throw new StoreError('PERSISTENCE_UNAVAILABLE');
    return { replayed: result.replayed, order: { ...order, items: order.items.map((line) => this.orderLine(line)) } };
  }

  async listOrders(actor: StoreActor, query: Record<string, unknown>) {
    const scope = actor.role === 'cliente' ? { customerId: actor.id } : {};
    const page = await this.orders.listOrders(scope, parsePaging(query, 10));
    return page;
  }

  async getOrder(actor: StoreActor, id: unknown) {
    const scope = actor.role === 'cliente' ? { customerId: actor.id } : {};
    const order = await this.orders.getOrder(validateUuid(id, 'El pedido'), scope);
    // Un pedido ajeno responde 404, igual que uno inexistente: no se revela qué identificadores existen.
    if (order === null) throw new StoreError('ORDER_NOT_FOUND');
    return { ...order, items: order.items.map((line) => this.orderLine(line)) };
  }
}

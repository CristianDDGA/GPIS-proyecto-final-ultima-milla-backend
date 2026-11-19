import type { FileStorage } from '../../../courier-applications/application/ports/file-storage.port.js';
import type {
  Category,
  DeliverySlot,
  NewProduct,
  OrderScope,
  Page,
  PlaceOrderCommand,
  PlaceOrderResult,
  Product,
  ProductEvent,
  ProductFilter,
  ProductPatch,
  StockReason,
  StoreOrderDetail,
  StoreOrderSummary,
  StoreSettings,
} from '../../domain/store.types.js';

/** Catálogo: lectura para clientes y administración. Las escrituras exigen un administrador activo. */
export interface CatalogRepository {
  listCategories(includeInactive: boolean): Promise<readonly Category[]>;
  createCategory(name: string, actorId: string): Promise<Category>;
  updateCategory(id: string, patch: { name?: string; isActive?: boolean }, expectedVersion: number, actorId: string): Promise<Category>;
  listProducts(filter: ProductFilter): Promise<Page<Product>>;
  /** includeInactive=false solo devuelve productos que un cliente puede comprar. */
  getProduct(id: string, includeInactive: boolean): Promise<Product | null>;
  createProduct(input: NewProduct, actorId: string): Promise<Product>;
  updateProduct(id: string, patch: ProductPatch, expectedVersion: number, actorId: string): Promise<Product>;
  /** Ajuste por diferencia (+/-): dos administradores a la vez nunca se pisan. */
  adjustStock(id: string, delta: number, reason: StockReason, actorId: string): Promise<{ readonly id: string; readonly stock: number }>;
  listProductEvents(id: string, limit: number): Promise<readonly ProductEvent[]>;
  getSettings(): Promise<StoreSettings>;
  updateSettings(settings: StoreSettings, actorId: string): Promise<StoreSettings>;
}

/** Pedidos de tienda y franjas de entrega. */
export interface StoreOrderRepository {
  /** null = la zona no existe. */
  deliverySlots(zoneId: string, date: string): Promise<readonly DeliverySlot[] | null>;
  /** Una sola operación atómica: valida, descuenta stock, reserva la franja y crea el pedido. Idempotente por clave. */
  placeOrder(command: PlaceOrderCommand): Promise<PlaceOrderResult>;
  listOrders(scope: OrderScope, paging: { readonly page: number; readonly pageSize: number }): Promise<Page<StoreOrderSummary>>;
  getOrder(id: string, scope: OrderScope): Promise<StoreOrderDetail | null>;
}

/** Almacén de imágenes de producto. Con Supabase Storage `publicUrl` devuelve la URL pública de la CDN. */
export interface ProductImageStorage extends FileStorage {
  /** URL pública directa, o null si las imágenes las sirve la propia API. */
  publicUrl(key: string): string | null;
}

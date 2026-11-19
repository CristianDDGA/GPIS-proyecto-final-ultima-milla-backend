import { SupabaseFileStorage } from '../infrastructure/storage/supabase-file-storage.js';
import type { FileStorage } from '../modules/courier-applications/application/ports/file-storage.port.js';
import { ApplicationError } from '../modules/courier-applications/domain/application.errors.js';
import { DiskFileStorage } from '../modules/courier-applications/infrastructure/storage/disk-file-storage.js';
import type { ProductImageStorage } from '../modules/store/application/ports/store.ports.js';
import { ProductImageStorageAdapter } from '../modules/store/infrastructure/storage/product-image-storage.js';
import type { AppConfig } from './config.js';

export interface Storages {
  /** Fotos de licencia y selfie de las solicitudes de conductor: datos personales, siempre privadas. */
  readonly courierStorage: FileStorage;
  /** Fotos del catálogo: públicas. */
  readonly productImages: ProductImageStorage;
}

/** Elige disco o Supabase Storage según STORAGE_DRIVER. Los buckets se crean en Supabase (ver docs/deploy). */
export function createStorages(config: Pick<AppConfig, 'storage' | 'courierUploadsDir' | 'productUploadsDir'>): Storages {
  if (config.storage.driver === 'supabase') {
    const { supabaseUrl, serviceRoleKey, productBucket, courierBucket } = config.storage;
    const products = new SupabaseFileStorage({
      url: supabaseUrl,
      serviceRoleKey,
      bucket: productBucket,
      onError: () => new Error('storage'),
    });
    return {
      courierStorage: new SupabaseFileStorage({
        url: supabaseUrl,
        serviceRoleKey,
        bucket: courierBucket,
        onError: () => new ApplicationError('PERSISTENCE_UNAVAILABLE'),
      }),
      productImages: new ProductImageStorageAdapter(products, (key) => products.publicUrl(key)),
    };
  }
  return {
    courierStorage: new DiskFileStorage(config.courierUploadsDir),
    productImages: new ProductImageStorageAdapter(new DiskFileStorage(config.productUploadsDir)),
  };
}

import type { FileStorage } from '../../../courier-applications/application/ports/file-storage.port.js';
import type { ProductImageStorage } from '../../application/ports/store.ports.js';
import { StoreError } from '../../domain/store.errors.js';

/**
 * Adapta cualquier FileStorage (disco, memoria, Supabase) al puerto de imágenes de producto.
 *  - Cualquier fallo del almacén sale como PERSISTENCE_UNAVAILABLE del módulo de tienda, sin detalles.
 *  - publicUrl: con Supabase devuelve la URL pública de la CDN; con disco o memoria es null y la API sirve la imagen.
 */
export class ProductImageStorageAdapter implements ProductImageStorage {
  constructor(
    private readonly inner: FileStorage,
    private readonly buildPublicUrl?: (key: string) => string,
  ) {}

  async save(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.inner.save(key, bytes);
    } catch {
      throw new StoreError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      return await this.inner.read(key);
    } catch {
      throw new StoreError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.inner.delete(key);
    } catch {
      throw new StoreError('PERSISTENCE_UNAVAILABLE');
    }
  }

  publicUrl(key: string): string | null {
    return this.buildPublicUrl ? this.buildPublicUrl(key) : null;
  }
}

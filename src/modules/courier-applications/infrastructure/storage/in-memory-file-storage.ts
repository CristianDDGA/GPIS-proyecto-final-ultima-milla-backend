import type { FileStorage } from '../../application/ports/file-storage.port.js';

/** Almacén en memoria para pruebas. */
export class InMemoryFileStorage implements FileStorage {
  private readonly files = new Map<string, Uint8Array>();

  async save(key: string, bytes: Uint8Array): Promise<void> {
    this.files.set(key, Uint8Array.from(bytes));
  }

  async read(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  get size(): number {
    return this.files.size;
  }

  has(key: string): boolean {
    return this.files.has(key);
  }
}

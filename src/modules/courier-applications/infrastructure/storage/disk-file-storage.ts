import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STORAGE_KEY_RE, type FileStorage } from '../../application/ports/file-storage.port.js';
import { ApplicationError } from '../../domain/application.errors.js';

function assertKey(key: string): void {
  // Solo nombres generados por el servidor: bloquea rutas relativas y nombres arbitrarios.
  if (!STORAGE_KEY_RE.test(key)) throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
}

/** Guarda las imágenes en una carpeta privada del servidor; nunca se sirve como estática. */
export class DiskFileStorage implements FileStorage {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async save(key: string, bytes: Uint8Array): Promise<void> {
    assertKey(key);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // wx: nunca sobrescribe un archivo existente.
      await writeFile(join(this.directory, key), bytes, { flag: 'wx', mode: 0o600 });
    } catch {
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async read(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    try {
      return await readFile(join(this.directory, key));
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    try {
      await rm(join(this.directory, key), { force: true });
    } catch {
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }
}

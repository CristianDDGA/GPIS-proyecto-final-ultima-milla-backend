import type { FileStorage } from '../../modules/courier-applications/application/ports/file-storage.port.js';
import { STORAGE_KEY_RE } from '../../modules/courier-applications/application/ports/file-storage.port.js';

// Almacén de imágenes sobre Supabase Storage, usando su API REST con fetch (sin dependencias nuevas).
//
//  - Solo el backend escribe: usa la clave de servicio (service_role), que NUNCA sale del servidor.
//  - Solo se aceptan nombres generados por el servidor (32 hex + .jpg/.png): bloquea rutas relativas y nombres ajenos.
//  - Nunca sobrescribe (x-upsert: false), igual que el almacén en disco.
//  - Un bucket público sirve lectura por URL directa (productos); uno privado solo se lee a través del backend
//    (fotos de licencia y selfie de conductores, que son datos personales).

export interface SupabaseStorageOptions {
  /** Origen del proyecto, por ejemplo https://abcdefghijklmnop.supabase.co (sin ruta). */
  readonly url: string;
  /** Clave service_role. Secreto: solo variables de entorno del servidor. */
  readonly serviceRoleKey: string;
  readonly bucket: string;
  /** Cada módulo decide con qué error responde cuando el almacén falla (sin detalles del proveedor). */
  readonly onError: () => Error;
  readonly timeoutMs?: number;
  /** Solo para pruebas. */
  readonly fetchImpl?: typeof fetch;
}

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = { jpg: 'image/jpeg', png: 'image/png' };

export class SupabaseFileStorage implements FileStorage {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: SupabaseStorageOptions) {
    const parsed = new URL(options.url);
    this.base = parsed.origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private objectUrl(key: string): string {
    if (!STORAGE_KEY_RE.test(key)) throw this.options.onError();
    return `${this.base}/storage/v1/object/${encodeURIComponent(this.options.bucket)}/${key}`;
  }

  /** URL pública directa; solo funciona si el bucket es público. */
  publicUrl(key: string): string {
    if (!STORAGE_KEY_RE.test(key)) throw this.options.onError();
    return `${this.base}/storage/v1/object/public/${encodeURIComponent(this.options.bucket)}/${key}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.options.serviceRoleKey}`,
          apikey: this.options.serviceRoleKey,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw this.options.onError();
    }
  }

  async save(key: string, bytes: Uint8Array): Promise<void> {
    const extension = key.slice(key.lastIndexOf('.') + 1);
    const contentType = CONTENT_TYPE_BY_EXTENSION[extension];
    if (contentType === undefined) throw this.options.onError();
    const response = await this.request(this.objectUrl(key), {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000' },
      body: Buffer.from(bytes),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw this.options.onError();
  }

  async read(key: string): Promise<Uint8Array | null> {
    const response = await this.request(this.objectUrl(key), { method: 'GET' });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      // Algunas versiones de Storage responden 400 con {"statusCode":"404"} cuando el objeto no existe.
      const text = await response.text().catch(() => '');
      if (response.status === 400 && /"statusCode"\s*:\s*"?404"?/.test(text)) return null;
      throw this.options.onError();
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.request(this.objectUrl(key), { method: 'DELETE' });
    await response.body?.cancel().catch(() => undefined);
    // Borrar algo que ya no existe no es un error.
    if (!response.ok && response.status !== 404) throw this.options.onError();
  }
}

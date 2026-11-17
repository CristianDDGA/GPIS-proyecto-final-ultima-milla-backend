/** Almacén de las imágenes de las solicitudes. Las claves son nombres aleatorios generados por el servidor. */
export interface FileStorage {
  save(key: string, bytes: Uint8Array): Promise<void>;
  /** null si no existe. */
  read(key: string): Promise<Uint8Array | null>;
  /** No falla si el archivo ya no existe. */
  delete(key: string): Promise<void>;
}

export const STORAGE_KEY_RE = /^[0-9a-f]{32}\.(?:jpg|png)$/;

// Lectura mínima de imágenes subidas: tipo real (por firma, no por extensión ni cabecera del cliente) y dimensiones.
// No decodifica la imagen; solo lee la cabecera, así que una imagen enorme no consume memoria ni CPU.

export type ImageType = 'image/jpeg' | 'image/png';

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Reconoce JPEG o PNG por su firma. */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'image/png';
  return null;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) * 0x1000000) + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  // Firma (8) + longitud (4) + "IHDR" (4) + ancho (4) + alto (4).
  if (bytes.length < 24) return null;
  const isHeader = bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (!isHeader) return null;
  return { width: readUInt32BE(bytes, 16), height: readUInt32BE(bytes, 20) };
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1] ?? 0;
    while (marker === 0xff) { // relleno entre marcadores
      offset += 1;
      marker = bytes[offset + 1] ?? 0;
    }
    // SOF0-SOF15, salvo DHT (C4), JPG (C8) y DAC (CC): llevan alto y ancho del cuadro.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: readUInt16BE(bytes, offset + 5), width: readUInt16BE(bytes, offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // marcadores sin longitud
      continue;
    }
    const length = readUInt16BE(bytes, offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** Dimensiones declaradas en la cabecera, o null si la cabecera está dañada o truncada. */
export function readImageSize(bytes: Uint8Array, type: ImageType): ImageSize | null {
  const size = type === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  if (size === null || size.width < 1 || size.height < 1) return null;
  return size;
}

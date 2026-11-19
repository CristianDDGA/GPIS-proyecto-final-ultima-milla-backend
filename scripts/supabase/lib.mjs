// Utilidades compartidas por los scripts de Supabase: lectura del paquete canónico de base de datos
// (.ci/database-package.zip, el que viaja en git) y hash de contraseña idéntico al de la API.
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, scrypt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Lee un ZIP (almacenado o deflate) y devuelve un Map nombre -> Buffer. Solo lo necesario para nuestro paquete. */
export function readZip(buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error('El paquete no es un ZIP válido.');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let entry = 0; entry < count; entry += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Directorio central del ZIP dañado.');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`Método de compresión no admitido en ${name}.`);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/**
 * Carga las migraciones del paquete canónico del repositorio y comprueba su integridad:
 * el ZIP coincide con su manifiesto y cada archivo con su SHA-256.
 */
export function loadCanonicalMigrations(zipPath, manifestPath) {
  const zip = readFileSync(zipPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (sha256(zip) !== manifest.sha256) throw new Error('El paquete canónico no coincide con su manifiesto (.ci/database-package.json).');
  const files = readZip(zip);
  const migrations = [];
  for (const [name, data] of files) {
    if (manifest.files?.[name] !== undefined && manifest.files[name] !== sha256(data)) {
      throw new Error(`El archivo ${name} del paquete no coincide con su SHA-256.`);
    }
    const match = /^database\/migrations\/(\d{3}_.+\.sql)$/.exec(name);
    if (match) migrations.push({ name: match[1], sql: data.toString('utf8'), checksum: sha256(data) });
  }
  migrations.sort((a, b) => a.name.localeCompare(b.name));
  return migrations;
}

/** Mismo formato que ScryptPasswordHasher de la API: scrypt$<sal hex>$<clave hex> (la sal se usa como texto). */
export function hashPassword(password) {
  const saltHex = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    scrypt(password, saltHex, 64, (error, derived) => {
      if (error) reject(error);
      else resolve(`scrypt$${saltHex}$${derived.toString('hex')}`);
    });
  });
}

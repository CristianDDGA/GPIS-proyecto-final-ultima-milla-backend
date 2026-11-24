#!/usr/bin/env node
// Regenera el paquete canónico de base de datos (.ci/database-package.zip) y su manifiesto desde db-proyecto.
//
//   node --env-file-if-exists=.env scripts/build-database-package.mjs            # escribe el ZIP y el manifiesto
//   node --env-file-if-exists=.env scripts/build-database-package.mjs --check    # solo comprueba que estén al día
//
// Reglas: el ZIP contiene exactamente los archivos de requiredFiles, byte por byte, sin modificar SQL; las fechas
// del ZIP son fijas, así que el mismo contenido produce siempre el mismo SHA-256. La imagen de PostgreSQL por
// digest se conserva del manifiesto actual.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { requiredFiles, verifyDatabasePackage } from './verify-database-package.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = resolve(root, '.ci/database-package.json');
const zipPath = resolve(root, '.ci/database-package.zip');
const check = process.argv.includes('--check');

const packageDir = resolve(root, process.env.DATABASE_PACKAGE_DIR ?? '../db-proyecto');
verifyDatabasePackage(packageDir);

// Fecha fija (2026-01-01 00:00) en formato MS-DOS: 7 bits de año desde 1980, 4 de mes, 5 de día.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, fileName, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(0o100644 * 0x10000, 38); // atributos externos: archivo normal 0644 (sin signo)
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);

    offset += local.length + fileName.length + compressed.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const entries = requiredFiles.map((name) => ({ name, data: readFileSync(resolve(packageDir, name)) }));
const files = Object.fromEntries(entries.map(({ name, data }) => [name, sha256(data)]));
const zip = buildZip(entries);

const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
const manifest = {
  source: 'db-proyecto auth + revocation + email verification + user activation + courier applications + store and flows packages (010_store.sql, 011_flows.sql, 012_consistency_definer.sql, 013_coordinates.sql, 014_google_login.sql, 015_profile_zone_coverage.sql, 016_route_optimization.sql, 017_single_admin.sql, 018_zone_name_unique.sql)',
  sha256: sha256(zip),
  files,
  postgresImage: previous.postgresImage,
};

if (check) {
  const current = readFileSync(zipPath);
  const same = sha256(current) === manifest.sha256 && JSON.stringify(previous.files) === JSON.stringify(files);
  process.stdout.write(same ? 'El paquete canónico está al día.\n' : 'El paquete canónico NO está al día: ejecuta scripts/build-database-package.mjs\n');
  process.exit(same ? 0 : 1);
}

writeFileSync(zipPath, zip);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
process.stdout.write(`Paquete canónico regenerado: ${entries.length} archivos, sha256 ${manifest.sha256}\n`);

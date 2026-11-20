import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredFiles = [
  'compose.test.yaml',
  'database/init/00-bootstrap.sh',
  'database/migrations/001_schema.sql',
  'database/migrations/002_integrity.sql',
  'database/migrations/003_commands.sql',
  'database/migrations/004_permissions.sql',
  'database/migrations/005_auth.sql',
  'database/migrations/006_auth_revocation.sql',
  'database/migrations/007_email_verification.sql',
  'database/migrations/008_user_activation.sql',
  'database/migrations/009_courier_applications.sql',
  'database/migrations/010_store.sql',
  'database/migrations/011_flows.sql',
  'database/migrations/012_consistency_definer.sql',
  'database/migrations/013_coordinates.sql',
  'database/scripts/migrate.sh',
  'database/seeds/demo.sql',
  'database/tests/integration.sql',
  'database/tests/run.sh',
  'database/tests/store.sql',
  'database/tests/store-race.sh',
  'database/tests/flows.sql',
  'database/tests/flows-race.sh',
];

export function verifyDatabasePackage(directory) {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new Error('Configura DATABASE_PACKAGE_DIR en .env con la carpeta del paquete de base de datos.');
  }
  const root = resolve(directory);
  for (const file of requiredFiles) {
    const path = resolve(root,file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Paquete de base incompleto: falta ${file}. Revisa DATABASE_PACKAGE_DIR y el paquete de base de datos.`);
    }
  }
  return requiredFiles.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = verifyDatabasePackage(process.env.DATABASE_PACKAGE_DIR);
  process.stdout.write(`Paquete externo disponible: ${count} archivos requeridos encontrados.\n`);
}

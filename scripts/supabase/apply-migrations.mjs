#!/usr/bin/env node
// Aplica el paquete de base de datos (db-proyecto/database/migrations) a un PostgreSQL gestionado,
// por ejemplo Supabase, sin Docker ni psql. Reproduce la lógica de database/scripts/migrate.sh:
//   - una transacción por migración, con candado consultivo para que dos ejecuciones no choquen;
//   - checksum SHA-256: una migración ya aplicada no puede editarse;
//   - es idempotente: volver a ejecutarlo solo aplica lo pendiente.
//
// Uso (desde la raíz del backend, con Node 24):
//   node --env-file-if-exists=.env scripts/supabase/apply-migrations.mjs [opciones]
//
// Variables:
//   MIGRATION_DATABASE_URL  Conexión DIRECTA (o pooler en modo sesión) con el usuario "postgres". Obligatoria.
//   DATABASE_PACKAGE_DIR    Carpeta del paquete de base de datos (por defecto ../db-proyecto).
//   DB_SSL / DB_SSL_CA      Igual que en la API: require | verify, y el certificado CA en PEM o su ruta.
//   APP_PASSWORD, WORKER_PASSWORD, READONLY_PASSWORD  Contraseñas de los roles (solo con --create-roles).
//
// Opciones:
//   --dry-run        Muestra qué se aplicaría y no cambia nada.
//   --create-roles   Crea los roles logistica_app, logistica_worker y logistica_readonly si no existen.
//   --set-passwords  Con --create-roles, también cambia la contraseña de los roles que ya existen.
//   --from-zip       Usa el paquete canónico del repositorio (.ci/database-package.zip, verificado contra su manifiesto)
//                    aunque exista la carpeta del paquete. Es lo que se recomienda para producción.
//   --no-harden      No revoca los permisos de anon/authenticated/service_role sobre el esquema logistica.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { loadCanonicalMigrations } from './lib.mjs';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const known = new Set(['--dry-run', '--create-roles', '--set-passwords', '--no-harden', '--from-zip']);
for (const arg of args) {
  if (!known.has(arg)) fail(`Opción desconocida: ${arg}`);
}
const dryRun = args.has('--dry-run');
const createRoles = args.has('--create-roles');
const setPasswords = args.has('--set-passwords');
const harden = !args.has('--no-harden');

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

// Nunca se imprime la URL completa: solo servidor y base, sin usuario ni contraseña.
function describeTarget(url) {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
}

function sslOption() {
  const mode = (process.env.DB_SSL ?? '').trim().toLowerCase();
  if (mode === '' || mode === 'disable') return undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify') {
    const raw = (process.env.DB_SSL_CA ?? '').trim();
    if (raw === '') return { rejectUnauthorized: true };
    const ca = raw.includes('BEGIN CERTIFICATE') ? raw.replace(/\\n/g, '\n') : readFileSync(resolve(raw), 'utf8');
    return { rejectUnauthorized: true, ca };
  }
  return fail('DB_SSL debe ser disable, require o verify.');
}

// pg da prioridad a sslmode de la URL sobre la opción ssl; se quita para que mande DB_SSL.
function connectionStringWithoutSslMode(url) {
  const parsed = new URL(url);
  parsed.searchParams.delete('sslmode');
  return parsed.toString();
}

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) fail('Falta MIGRATION_DATABASE_URL (conexión directa con el usuario postgres).');
let parsedUrl;
try { parsedUrl = new URL(databaseUrl); } catch { fail('MIGRATION_DATABASE_URL no es una URL válida.'); }
if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) fail('MIGRATION_DATABASE_URL debe ser postgresql://');
if (/\.pooler\.supabase\.com$/.test(parsedUrl.hostname) && parsedUrl.port === '6543') {
  fail('Las migraciones no deben usar el pooler en modo transacción (puerto 6543). Usa la conexión directa o el pooler en modo sesión (5432).');
}

const packageDir = resolve(process.env.DATABASE_PACKAGE_DIR ?? '../db-proyecto');
const migrationsDir = join(packageDir, 'database', 'migrations');
// Sin carpeta del paquete (por ejemplo en otra máquina con solo el repositorio) se usa el paquete canónico de git.
const useZip = args.has('--from-zip') || !existsSync(migrationsDir);

function loadMigrations() {
  if (useZip) {
    try {
      return loadCanonicalMigrations(
        new URL('../../.ci/database-package.zip', import.meta.url),
        new URL('../../.ci/database-package.json', import.meta.url),
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  const files = readdirSync(migrationsDir).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  return files.map((name) => ({
    name,
    sql: readFileSync(join(migrationsDir, name), 'utf8'),
    checksum: createHash('sha256').update(readFileSync(join(migrationsDir, name))).digest('hex'),
  }));
}

const migrations = loadMigrations();
if (migrations.length === 0) fail('No hay migraciones .sql en el paquete.');
for (const migration of migrations) {
  // Las migraciones se envían por el protocolo normal: no pueden usar meta-comandos de psql (\ir, \set...).
  if (/^\\/m.test(migration.sql)) fail(`${migration.name} contiene meta-comandos de psql; no se puede aplicar sin psql.`);
}

const client = new pg.Client({
  connectionString: connectionStringWithoutSslMode(databaseUrl),
  ssl: sslOption(),
  connectionTimeoutMillis: 15_000,
  application_name: 'logistica-migrations',
});

const ROLES = [
  ['logistica_app', 'APP_PASSWORD'],
  ['logistica_worker', 'WORKER_PASSWORD'],
  ['logistica_readonly', 'READONLY_PASSWORD'],
];

async function ensureRoles() {
  for (const [role, variable] of ROLES) {
    const password = process.env[variable];
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
    if (exists && !setPasswords) {
      process.stdout.write(`Rol ${role}: ya existe (sin cambios).\n`);
      continue;
    }
    if (typeof password !== 'string' || password.length < 16 || /\s/.test(password)) {
      fail(`${variable} debe tener al menos 16 caracteres y no contener espacios.`);
    }
    const literal = client.escapeLiteral(password);
    if (dryRun) {
      process.stdout.write(`Rol ${role}: se ${exists ? 'cambiaría la contraseña' : 'crearía'} (dry-run).\n`);
    } else if (exists) {
      await client.query(`ALTER ROLE ${role} PASSWORD ${literal}`);
      process.stdout.write(`Rol ${role}: contraseña actualizada.\n`);
    } else {
      await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal}`);
      process.stdout.write(`Rol ${role}: creado.\n`);
    }
  }
}

async function appliedMigrations() {
  const exists = await client.query("SELECT to_regclass('logistica.schema_migrations') IS NOT NULL AS ok");
  if (!exists.rows[0].ok) return new Map();
  const result = await client.query('SELECT version, checksum FROM logistica.schema_migrations');
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

async function applyMigration(migration) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(19401013, 1)');
    const done = await client.query('SELECT checksum FROM logistica.schema_migrations WHERE version = $1', [migration.name]);
    if (done.rowCount > 0) {
      if (done.rows[0].checksum !== migration.checksum) {
        throw new Error(`no se puede editar una migración ya aplicada: ${migration.name}`);
      }
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(migration.sql);
    await client.query('INSERT INTO logistica.schema_migrations(version, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

// Supabase publica por su API los esquemas configurados y concede privilegios a anon/authenticated/service_role.
// logistica no debe ser accesible por esa vía: solo por logistica_app/worker/readonly desde el backend.
async function hardenApiRoles() {
  const found = await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')");
  const roles = found.rows.map((row) => row.rolname);
  if (roles.length === 0) {
    process.stdout.write('Endurecimiento: no hay roles de la API de Supabase en este servidor (nada que revocar).\n');
    return;
  }
  const list = roles.join(', ');
  if (dryRun) {
    process.stdout.write(`Endurecimiento: se revocaría el acceso de ${list} al esquema logistica (dry-run).\n`);
    return;
  }
  await client.query(`REVOKE ALL ON SCHEMA logistica FROM ${list}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA logistica FROM ${list}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA logistica FROM ${list}`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA logistica FROM ${list}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA logistica REVOKE ALL ON TABLES FROM ${list}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA logistica REVOKE ALL ON FUNCTIONS FROM ${list}`);
  process.stdout.write(`Endurecimiento: acceso de ${list} al esquema logistica revocado.\n`);
}

async function report() {
  const schema = await client.query("SELECT to_regnamespace('logistica') IS NOT NULL AS ok");
  if (!schema.rows[0].ok) {
    process.stdout.write('\nEl esquema logistica aún no existe (ensayo sobre una base vacía): no hay accesos que comprobar.\n');
    return;
  }
  const rows = await client.query(`
    SELECT r.rolname,
           has_schema_privilege(r.rolname, 'logistica', 'USAGE') AS usa_logistica
    FROM pg_roles r
    WHERE r.rolname IN ('logistica_app', 'logistica_worker', 'logistica_readonly', 'anon', 'authenticated', 'service_role')
    ORDER BY r.rolname`);
  process.stdout.write('\nRoles y acceso al esquema logistica:\n');
  for (const row of rows.rows) {
    process.stdout.write(`  ${row.rolname.padEnd(20)} USAGE=${row.usa_logistica}\n`);
  }
}

try {
  process.stdout.write(`Destino: ${describeTarget(databaseUrl)}${dryRun ? '  (dry-run)' : ''}\n`);
  process.stdout.write(`Paquete: ${useZip ? 'canónico del repositorio (.ci/database-package.zip)' : packageDir} · ${migrations.length} migraciones\n`);
  await client.connect();
  if (createRoles) await ensureRoles();

  if (!dryRun) {
    await client.query('CREATE SCHEMA IF NOT EXISTS logistica');
    await client.query(`CREATE TABLE IF NOT EXISTS logistica.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  }

  const applied = await appliedMigrations();
  let count = 0;
  for (const migration of migrations) {
    const previous = applied.get(migration.name);
    if (previous !== undefined) {
      if (previous !== migration.checksum) fail(`no se puede editar una migración ya aplicada: ${migration.name}`);
      process.stdout.write(`  ya aplicada   ${migration.name}\n`);
      continue;
    }
    if (dryRun) {
      process.stdout.write(`  se aplicaría  ${migration.name}\n`);
      continue;
    }
    await applyMigration(migration);
    count += 1;
    process.stdout.write(`  aplicada      ${migration.name}\n`);
  }

  if (harden) await hardenApiRoles();
  await report();
  process.stdout.write(`\nListo. ${dryRun ? 'Nada se modificó.' : `${count} migración(es) nueva(s).`}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await client.end().catch(() => undefined);
}

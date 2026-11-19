import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Opciones de conexión a PostgreSQL que cambian entre el entorno local (Docker) y uno gestionado (Supabase).
// Todo se controla con variables de entorno; sin ellas el comportamiento es el mismo de siempre.

export type DatabaseSsl = false | { readonly rejectUnauthorized: boolean; readonly ca?: string };

export interface DatabaseOptions {
  /** Cadena de conexión; se le quita sslmode cuando DB_SSL manda, porque la librería da prioridad a la URL. */
  readonly connectionString: string;
  readonly max: number;
  /** undefined = no enviar statement_timeout como parámetro de arranque (útil tras un pooler). */
  readonly statementTimeoutMs?: number;
  /** undefined = no tocar: se respeta lo que diga la URL (sslmode). */
  readonly ssl?: DatabaseSsl;
}

const DEFAULT_POOL_MAX = 25;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(resolve(path), 'utf8');

function parseSsl(env: NodeJS.ProcessEnv, readFile: ReadFile): DatabaseSsl | undefined {
  const mode = (env['DB_SSL'] ?? '').trim().toLowerCase();
  if (mode === '') return undefined;
  if (mode === 'disable') return false;
  // require: cifra la conexión sin validar el servidor (como sslmode=require de libpq).
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify') {
    const raw = (env['DB_SSL_CA'] ?? '').trim();
    if (raw === '') return { rejectUnauthorized: true };
    // El CA se admite como PEM (con \n escapados si viene de una variable de una sola línea) o como ruta a un archivo.
    const ca = raw.includes('BEGIN CERTIFICATE') ? raw.replace(/\\n/g, '\n') : readFile(raw);
    return { rejectUnauthorized: true, ca };
  }
  throw new Error('DB_SSL debe ser disable, require o verify.');
}

function withoutSslMode(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

function parsePoolMax(env: NodeJS.ProcessEnv): number {
  const configured = Number(env['DB_POOL_MAX'] ?? DEFAULT_POOL_MAX);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_POOL_MAX;
}

function parseStatementTimeout(env: NodeJS.ProcessEnv): number | undefined {
  const send = (env['DB_SEND_STATEMENT_TIMEOUT'] ?? 'true').trim().toLowerCase();
  if (send !== 'true' && send !== 'false') {
    throw new Error('DB_SEND_STATEMENT_TIMEOUT debe ser true o false.');
  }
  if (send === 'false') return undefined;
  // Ajustable para planificaciones de alto volumen (generate_routes) sin recompilar.
  const configured = Number(env['DB_STATEMENT_TIMEOUT_MS'] ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1_000 ? configured : DEFAULT_STATEMENT_TIMEOUT_MS;
}

export function resolveDatabaseOptions(
  connectionString: string,
  env: NodeJS.ProcessEnv,
  readFile: ReadFile = defaultReadFile
): DatabaseOptions {
  const ssl = parseSsl(env, readFile);
  const statementTimeoutMs = parseStatementTimeout(env);
  return {
    connectionString: ssl === undefined ? connectionString : withoutSslMode(connectionString),
    max: parsePoolMax(env),
    ...(statementTimeoutMs !== undefined ? { statementTimeoutMs } : {}),
    ...(ssl !== undefined ? { ssl } : {}),
  };
}

/** El usuario de la API es logistica_app; con el pooler de Supabase llega como logistica_app.<id-del-proyecto>. */
const APP_ROLE_USER = /^logistica_app(?:\.[A-Za-z0-9_-]{1,64})?$/;

export function isAppRoleUser(username: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(username); } catch { return false; }
  return APP_ROLE_USER.test(decoded);
}

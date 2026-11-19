import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppRoleUser, resolveDatabaseOptions } from '../../src/bootstrap/database-options.js';
import { loadConfig } from '../../src/bootstrap/config.js';

const URL_LOCAL = 'postgresql://logistica_app:secreto@127.0.0.1:15432/logistica';
const URL_POOLER = 'postgresql://logistica_app.abcdefghijklmnop:secreto@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require';
const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ ...overrides }) as NodeJS.ProcessEnv;

test('sin variables: mismo comportamiento de siempre (25 conexiones, 10 s, URL intacta, sin tocar SSL)', () => {
  const options = resolveDatabaseOptions(URL_LOCAL, env());
  assert.equal(options.max, 25);
  assert.equal(options.statementTimeoutMs, 10_000);
  assert.equal(options.ssl, undefined);
  assert.equal(options.connectionString, URL_LOCAL);
});

test('DB_POOL_MAX y DB_STATEMENT_TIMEOUT_MS se respetan y los valores inválidos vuelven al valor por defecto', () => {
  assert.equal(resolveDatabaseOptions(URL_LOCAL, env({ DB_POOL_MAX: '10' })).max, 10);
  assert.equal(resolveDatabaseOptions(URL_LOCAL, env({ DB_POOL_MAX: '0' })).max, 25);
  assert.equal(resolveDatabaseOptions(URL_LOCAL, env({ DB_POOL_MAX: 'abc' })).max, 25);
  assert.equal(resolveDatabaseOptions(URL_LOCAL, env({ DB_STATEMENT_TIMEOUT_MS: '30000' })).statementTimeoutMs, 30_000);
  assert.equal(resolveDatabaseOptions(URL_LOCAL, env({ DB_STATEMENT_TIMEOUT_MS: '10' })).statementTimeoutMs, 10_000);
});

test('DB_SEND_STATEMENT_TIMEOUT=false no envía statement_timeout como parámetro de arranque', () => {
  const options = resolveDatabaseOptions(URL_LOCAL, env({ DB_SEND_STATEMENT_TIMEOUT: 'false' }));
  assert.equal('statementTimeoutMs' in options, false);
  assert.throws(() => resolveDatabaseOptions(URL_LOCAL, env({ DB_SEND_STATEMENT_TIMEOUT: 'si' })), /true o false/);
});

test('DB_SSL=require cifra sin validar el servidor y quita sslmode de la URL para que mande DB_SSL', () => {
  const options = resolveDatabaseOptions(URL_POOLER, env({ DB_SSL: 'require' }));
  assert.deepEqual(options.ssl, { rejectUnauthorized: false });
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'), false);
  assert.equal(new URL(options.connectionString).username, 'logistica_app.abcdefghijklmnop');
});

test('DB_SSL=disable apaga SSL aunque la URL lo pida', () => {
  const options = resolveDatabaseOptions(URL_POOLER, env({ DB_SSL: 'disable' }));
  assert.equal(options.ssl, false);
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'), false);
});

test('DB_SSL=verify valida el certificado; el CA puede venir como PEM de una línea o como ruta', () => {
  assert.deepEqual(resolveDatabaseOptions(URL_POOLER, env({ DB_SSL: 'verify' })).ssl, { rejectUnauthorized: true });
  const pem = '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----';
  const fromPem = resolveDatabaseOptions(URL_POOLER, env({ DB_SSL: 'verify', DB_SSL_CA: pem }));
  assert.deepEqual(fromPem.ssl, { rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----' });
  const fromFile = resolveDatabaseOptions(URL_POOLER, env({ DB_SSL: 'verify', DB_SSL_CA: './ca.crt' }), (path) => `contenido de ${path}`);
  assert.deepEqual(fromFile.ssl, { rejectUnauthorized: true, ca: 'contenido de ./ca.crt' });
});

test('DB_SSL con un valor desconocido falla', () => {
  assert.throws(() => resolveDatabaseOptions(URL_LOCAL, env({ DB_SSL: 'maybe' })), /disable, require o verify/);
});

test('isAppRoleUser acepta logistica_app y logistica_app.<id del proyecto>, y rechaza cualquier otro rol', () => {
  assert.equal(isAppRoleUser('logistica_app'), true);
  assert.equal(isAppRoleUser('logistica_app.abcdefghijklmnop'), true);
  assert.equal(isAppRoleUser('logistica_app.proyecto-1_x'), true);
  for (const bad of ['postgres', 'logistica_admin', 'logistica_worker', 'logistica_app.', 'logistica_app.a.b', 'logistica_app x', 'logistica_appx', '', 'LOGISTICA_APP', 'logistica_app%zz']) {
    assert.equal(isAppRoleUser(bad), false, bad);
  }
});

test('loadConfig: acepta la URL del pooler de Supabase y rechaza usuarios que no son logistica_app', () => {
  const base = { JWT_SECRET: 'a'.repeat(16) + 'B'.repeat(16) };
  assert.equal(loadConfig(env({ ...base, DATABASE_URL: URL_POOLER, DB_SSL: 'require' })).databaseUrl, URL_POOLER);
  assert.throws(() => loadConfig(env({ ...base, DATABASE_URL: 'postgresql://postgres:x@db.supabase.co:5432/postgres' })), /logistica_app/);
  assert.throws(() => loadConfig(env({ ...base, DATABASE_URL: 'postgresql://logistica_worker:x@127.0.0.1:5432/logistica' })), /logistica_app/);
});

test('loadConfig: una variable DB_SSL inválida hace fallar el arranque, no la primera consulta', () => {
  const base = { JWT_SECRET: 'a'.repeat(16) + 'B'.repeat(16), DATABASE_URL: URL_LOCAL };
  assert.throws(() => loadConfig(env({ ...base, DB_SSL: 'nope' })), /DB_SSL/);
});

#!/usr/bin/env node
// Crea el PRIMER administrador (rol "personal") en una base recién migrada. Una base nueva no tiene usuarios y el
// registro público solo crea clientes, así que sin este paso nadie podría entrar al panel.
//
// Uso (desde la raíz del backend, con Node 24):
//   node --env-file-if-exists=.env scripts/supabase/create-admin.mjs
//
// Variables (solo en tu terminal, no las guardes en archivos versionados):
//   MIGRATION_DATABASE_URL  Conexión DIRECTA (5432) con el usuario postgres. Obligatoria.
//   ADMIN_EMAIL             Correo del administrador (ASCII).
//   ADMIN_PASSWORD          Contraseña: 12 a 128 caracteres, sin el correo dentro. Se guarda solo su hash scrypt.
//   ADMIN_NAME              Nombre visible (opcional).
//   DB_SSL / DB_SSL_CA      Igual que la API.
//
// Es seguro repetirlo: si el correo ya existe, no toca nada. El administrador nace con el correo verificado y puede
// cambiar su clave luego desde la API (`POST /auth/change-password`).
import process from 'node:process';
import { URL } from 'node:url';
import pg from 'pg';
import { hashPassword, sslOptionFromEnv } from './lib.mjs';

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function sslOption() {
  try { return sslOptionFromEnv(); } catch (error) { return fail(error.message); }
}

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) fail('Falta MIGRATION_DATABASE_URL (conexión directa con el usuario postgres).');
let parsedUrl;
try { parsedUrl = new URL(databaseUrl); } catch { fail('MIGRATION_DATABASE_URL no es una URL válida.'); }
if (/\.pooler\.supabase\.com$/.test(parsedUrl.hostname) && parsedUrl.port === '6543') {
  fail('Usa la conexión directa o el pooler en modo sesión (5432), no el 6543.');
}

const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
const name = (process.env.ADMIN_NAME ?? '').trim();

if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 254) fail('ADMIN_EMAIL no es un correo válido (solo ASCII).');
if (password.length < 12 || password.length > 128) fail('ADMIN_PASSWORD debe tener entre 12 y 128 caracteres.');
if (password !== password.trim()) fail('ADMIN_PASSWORD no puede empezar ni terminar con espacios.');
if (password.toLowerCase().includes(email.split('@')[0])) fail('ADMIN_PASSWORD no puede contener la parte local del correo.');
if (/^(.)\1+$/.test(password) || /^\d+$/.test(password)) fail('ADMIN_PASSWORD es demasiado débil (solo repeticiones o solo números).');
if (name !== '' && !/^[\p{L}][\p{L} .'-]{1,118}[\p{L}.]$/u.test(name)) fail('ADMIN_NAME solo admite letras, espacios, punto, guion y apóstrofo.');

const client = new pg.Client({
  connectionString: (() => { const copy = new URL(databaseUrl); copy.searchParams.delete('sslmode'); return copy.toString(); })(),
  ssl: sslOption(),
  connectionTimeoutMillis: 15_000,
  application_name: 'logistica-create-admin',
});

try {
  await client.connect();
  const ready = await client.query("SELECT to_regclass('logistica.app_users') IS NOT NULL AS ok");
  if (!ready.rows[0].ok) fail('El esquema logistica no existe: aplica primero las migraciones (apply-migrations.mjs).');

  const existing = await client.query('SELECT id, role FROM logistica.app_users WHERE lower(email) = $1', [email]);
  if (existing.rowCount > 0) {
    process.stdout.write(`Ya existe una cuenta con ese correo (rol ${existing.rows[0].role}). No se cambió nada.\n`);
  } else {
    const hash = await hashPassword(password);
    await client.query('BEGIN');
    try {
      // Los disparadores de la base usan nombres sin esquema (igual que las migraciones, que fijan este search_path).
      await client.query('SET LOCAL search_path = logistica, pg_catalog');
      const created = await client.query(
        'SELECT logistica.register_app_user($1, $2, $3, $4, $5) AS id',
        [email, email, hash, 'personal', name === '' ? null : name],
      );
      // La cuenta del administrador no pasa por el código de 6 dígitos: nace verificada.
      await client.query(
        "UPDATE logistica.app_users SET email_verified_at = clock_timestamp(), email_verified_via = 'admin' WHERE id = $1",
        [created.rows[0].id],
      );
      await client.query('COMMIT');
      process.stdout.write(`Administrador creado: ${email}\n`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await client.end().catch(() => undefined);
}

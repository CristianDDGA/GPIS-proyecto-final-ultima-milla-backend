import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/bootstrap/config.js';

const GOOD_SECRET = 'a'.repeat(16) + 'B'.repeat(16);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { JWT_SECRET: GOOD_SECRET, ...overrides } as NodeJS.ProcessEnv;
}

test('JWT_SECRET: acepta un secreto de 32 caracteres', () => {
  assert.equal(loadConfig(env()).jwtSecret, GOOD_SECRET);
});

test('JWT_SECRET: es obligatorio también fuera de producción', () => {
  assert.throws(() => loadConfig(env({ JWT_SECRET: undefined })), /JWT_SECRET es obligatorio/);
  assert.throws(() => loadConfig(env({ JWT_SECRET: '   ' })), /JWT_SECRET es obligatorio/);
  assert.throws(() => loadConfig(env({ JWT_SECRET: undefined, NODE_ENV: 'development' })), /obligatorio/);
});

test('JWT_SECRET: rechaza secretos cortos', () => {
  assert.throws(() => loadConfig(env({ JWT_SECRET: 'x'.repeat(31) })), /al menos 32/);
});

test('JWT_SECRET: rechaza el secreto público que estuvo en el código y los valores de ejemplo', () => {
  assert.throws(() => loadConfig(env({ JWT_SECRET: 'dev-only-jwt-secret-change-in-prod' })), /valor de ejemplo|público/);
  assert.throws(() => loadConfig(env({ JWT_SECRET: 'REEMPLAZAR_CON_SECRETO_SEGURO_DE_AL_MENOS_32_CHARS' })), /valor de ejemplo|público/);
});

test('JWT_SECRET: el mensaje de error explica cómo generar uno', () => {
  assert.throws(() => loadConfig(env({ JWT_SECRET: undefined })), /randomBytes/);
});

test('GOOGLE_CLIENT_ID: es opcional, se acepta con su formato y se rechaza si no lo tiene', () => {
  assert.equal(loadConfig(env()).googleClientId, undefined);
  assert.equal(loadConfig(env({ GOOGLE_CLIENT_ID: '   ' })).googleClientId, undefined);
  const id = '1234567890-abcdef123.apps.googleusercontent.com';
  assert.equal(loadConfig(env({ GOOGLE_CLIENT_ID: ` ${id} ` })).googleClientId, id);
  assert.throws(() => loadConfig(env({ GOOGLE_CLIENT_ID: 'GOCSPX-un-secreto-de-cliente' })), /GOOGLE_CLIENT_ID/);
  assert.throws(() => loadConfig(env({ GOOGLE_CLIENT_ID: 'https://evil.example.com' })), /GOOGLE_CLIENT_ID/);
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/bootstrap/config.js';
import { AuthError } from '../../src/modules/auth/domain/auth.errors.js';
import { validateNewPassword } from '../../src/modules/auth/domain/password-policy.js';
import { InMemoryLoginAttemptStore } from '../../src/modules/auth/infrastructure/crypto/in-memory-login-attempt.store.js';

const isValidation = (error: unknown) => error instanceof AuthError && error.code === 'VALIDATION_ERROR';

describe('política de contraseñas nuevas', () => {
  test('acepta claves largas, frases y combinaciones únicas sin exigir símbolos', () => {
    for (const ok of ['ClaveSegura2026', 'mi gato come atún los jueves', 'Tr0ub4dor&3x', 'K6SmokePassword2026!', 'AdminPassword123', 'ConductorClave1']) {
      assert.equal(validateNewPassword(ok), ok);
    }
  });

  test('rechaza claves de lista, con adornos triviales, repetidas y solo numéricas', () => {
    const weak = [
      'password', 'Password123', 'PASSWORD1', 'qwerty123', '12345678', '1234567890', 'iloveyou', 'abc12345',
      'Password2026!', 'Admin#2026', 'Contrasena1', 'Clave1234', 'aaaaaaaa', 'abababab', '1111111111',
    ];
    for (const value of weak) {
      assert.throws(() => validateNewPassword(value), isValidation, value);
    }
  });

  test('rechaza claves que contienen el correo del usuario', () => {
    assert.throws(() => validateNewPassword('ana.perez2026', 'ana.perez@test.com'), isValidation);
    assert.throws(() => validateNewPassword('ana.perez@test.com', 'ana.perez@test.com'), isValidation);
    assert.equal(validateNewPassword('ana.perez2026', 'otra@test.com'), 'ana.perez2026');
    assert.equal(validateNewPassword('xyz12345Abc', 'xyz@test.com'), 'xyz12345Abc', 'parte local de menos de 4 letras no cuenta');
  });

  test('mantiene el largo de 8 a 128 caracteres', () => {
    assert.throws(() => validateNewPassword('Corta1'), isValidation);
    assert.throws(() => validateNewPassword(`${'a1'.repeat(65)}x`), isValidation);
    assert.throws(() => validateNewPassword(undefined), isValidation);
  });
});

describe('bloqueo de cuenta en memoria', () => {
  const options = (now: () => number) => ({ maxFailures: 3, lockSeconds: 60, windowSeconds: 600, now });

  test('bloquea al llegar al máximo de fallos y se libera al pasar el tiempo', async () => {
    let clock = 1_000_000;
    const store = new InMemoryLoginAttemptStore(options(() => clock));
    await store.recordFailure('ana@test.com');
    await store.recordFailure('ana@test.com');
    assert.equal(await store.lockedForSeconds('ana@test.com'), 0);
    await store.recordFailure('ana@test.com');
    assert.equal(await store.lockedForSeconds('ana@test.com'), 60);
    clock += 30_500;
    assert.equal(await store.lockedForSeconds('ana@test.com'), 30);
    clock += 30_000;
    assert.equal(await store.lockedForSeconds('ana@test.com'), 0);
  });

  test('los fallos fuera de la ventana no cuentan y reset() los borra', async () => {
    let clock = 2_000_000;
    const store = new InMemoryLoginAttemptStore(options(() => clock));
    await store.recordFailure('ana@test.com');
    await store.recordFailure('ana@test.com');
    clock += 601_000;
    await store.recordFailure('ana@test.com');
    assert.equal(await store.lockedForSeconds('ana@test.com'), 0, 'los dos primeros caducaron');
    await store.recordFailure('ana@test.com');
    await store.reset('ana@test.com');
    await store.recordFailure('ana@test.com');
    await store.recordFailure('ana@test.com');
    assert.equal(await store.lockedForSeconds('ana@test.com'), 0, 'reset reinició la cuenta');
  });

  test('cada cuenta tiene su contador y la memoria está acotada', async () => {
    const store = new InMemoryLoginAttemptStore(options(() => 3_000_000));
    for (let index = 0; index < 3; index += 1) await store.recordFailure('a@test.com');
    assert.equal(await store.lockedForSeconds('a@test.com'), 60);
    assert.equal(await store.lockedForSeconds('b@test.com'), 0);
    for (let index = 0; index < 10_500; index += 1) await store.recordFailure(`bot${index}@test.com`);
    assert.equal(await store.lockedForSeconds('b@test.com'), 0);
  });
});

describe('configuración del bloqueo y de la sesión', () => {
  const base = { JWT_SECRET: 'unit-test-jwt-secret-abcdefghijklmnopqrstuvwxyz' } as NodeJS.ProcessEnv;

  test('valores por defecto: 5 fallos, 5 minutos y token de 8 horas', () => {
    const config = loadConfig(base);
    assert.deepEqual(config.loginLockout, { maxFailures: 5, lockSeconds: 300 });
    assert.equal(config.jwtExpiresInSeconds, 28_800);
  });

  test('valida los límites configurables', () => {
    assert.throws(() => loadConfig({ ...base, LOGIN_MAX_FAILED_ATTEMPTS: '1' }), /LOGIN_MAX_FAILED_ATTEMPTS/);
    assert.throws(() => loadConfig({ ...base, LOGIN_LOCK_SECONDS: '5' }), /LOGIN_LOCK_SECONDS/);
    assert.deepEqual(loadConfig({ ...base, LOGIN_MAX_FAILED_ATTEMPTS: '10', LOGIN_LOCK_SECONDS: '900' }).loginLockout, { maxFailures: 10, lockSeconds: 900 });
  });
});

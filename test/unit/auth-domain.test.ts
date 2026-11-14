import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toPublicRole,
  validateDisplayName,
  validateEmail,
  validatePassword,
  validateRole,
} from '../../src/modules/auth/domain/auth-user.entity.js';
import { AuthError } from '../../src/modules/auth/domain/auth.errors.js';
import { ScryptPasswordHasher } from '../../src/modules/auth/infrastructure/crypto/scrypt-password-hasher.js';
import { HmacJwtTokenService } from '../../src/modules/auth/infrastructure/crypto/hmac-jwt.token-service.js';

describe('Auth Domain & Crypto Unit Tests', () => {
  test('valida y normaliza correo, contraseña, nombre y los 3 roles', () => {
    assert.equal(validateEmail('  Cliente@Example.COM '), 'cliente@example.com');
    assert.equal(validatePassword('ClaveSegura123'), 'ClaveSegura123');
    assert.equal(validateDisplayName('  Juan Pérez  '), 'Juan Pérez');
    assert.equal(validateDisplayName('   '), null);

    assert.equal(validateRole('admin'), 'personal');
    assert.equal(validateRole('personal'), 'personal');
    assert.equal(validateRole('repartidor'), 'repartidor');
    assert.equal(validateRole('cliente'), 'cliente');

    assert.equal(toPublicRole('personal'), 'admin');
    assert.equal(toPublicRole('repartidor'), 'repartidor');
    assert.equal(toPublicRole('cliente'), 'cliente');
  });

  test('rechaza correos, contraseñas o roles inválidos', () => {
    assert.throws(() => validateEmail('no-es-correo'), (e: unknown) => e instanceof AuthError && e.code === 'VALIDATION_ERROR');
    assert.throws(() => validatePassword('1234567'), (e: unknown) => e instanceof AuthError && e.code === 'VALIDATION_ERROR');
    assert.throws(() => validateRole('superadmin'), (e: unknown) => e instanceof AuthError && e.code === 'VALIDATION_ERROR');
  });

  test('ScryptPasswordHasher genera hashes únicos y verifica correctamente', async () => {
    const hasher = new ScryptPasswordHasher();
    const hash1 = await hasher.hash('MiClaveSecreta2026');
    const hash2 = await hasher.hash('MiClaveSecreta2026');

    assert.notEqual(hash1, hash2);
    assert.equal(await hasher.verify('MiClaveSecreta2026', hash1), true);
    assert.equal(await hasher.verify('OtraClaveIncorrecta', hash1), false);
    assert.equal(await hasher.verify('MiClaveSecreta2026', 'formato-invalido'), false);
  });

  test('HmacJwtTokenService firma, verifica y rechaza tokens manipulados o expirados', () => {
    const tokens = new HmacJwtTokenService('secret-test-key-with-at-least-16-chars', 3600);
    const jwt = tokens.sign({
      sub: '30000000-0000-4000-8000-000000000001',
      role: 'personal',
      authSubject: 'admin@ultima-milla.test',
      courierId: null,
    });

    const payload = tokens.verify(jwt);
    assert.equal(payload.sub, '30000000-0000-4000-8000-000000000001');
    assert.equal(payload.role, 'personal');

    const parts = jwt.split('.');
    const tampered = `${parts[0]}.${parts[1]}.firma_falsa`;
    assert.throws(() => tokens.verify(tampered), (e: unknown) => e instanceof AuthError && e.code === 'UNAUTHORIZED');

    const expiredService = new HmacJwtTokenService('secret-test-key-with-at-least-16-chars', -10);
    const expiredJwt = expiredService.sign({
      sub: '30000000-0000-4000-8000-000000000001',
      role: 'cliente',
      authSubject: 'cliente@ultima-milla.test',
      courierId: null,
    });
    assert.throws(() => tokens.verify(expiredJwt), (e: unknown) => e instanceof AuthError && e.code === 'UNAUTHORIZED');
  });
});

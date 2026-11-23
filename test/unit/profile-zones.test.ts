import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePhone } from '../../src/modules/auth/domain/auth-user.entity.js';
import { AuthError } from '../../src/modules/auth/domain/auth.errors.js';
import { firstNameOf } from '../../src/modules/store/domain/store.types.js';
import { Zone, distanceKm, validateCoverage, validatePoint } from '../../src/modules/zones/domain/zone.entity.js';
import { ZoneValidationError } from '../../src/modules/zones/domain/zone.errors.js';

const NOW = new Date('2026-11-23T15:00:00.000Z');
const ID = '3f2b8c1e-9a4d-4c2b-8e1f-123456789abc';

test('distanceKm: misma fórmula que la base (Quito–Ambato ~120 km, mismo punto 0)', () => {
  assert.equal(distanceKm(-1.2491, -78.6167, -1.2491, -78.6167), 0);
  assert.ok(Math.abs(distanceKm(-0.1807, -78.4678, -1.2491, -78.6167) - 119.9) < 2);
});

test('validatePoint: números dentro de Ecuador', () => {
  assert.deepEqual(validatePoint(-1.24, -78.62), { latitude: -1.24, longitude: -78.62 });
  assert.throws(() => validatePoint('-1.24', -78.62), ZoneValidationError);
  assert.throws(() => validatePoint(Number.NaN, -78.62), ZoneValidationError);
  assert.throws(() => validatePoint(40.4, -3.7), ZoneValidationError);
});

test('validateCoverage: radio de 0,1 a 50 km, campos cerrados y null para quitarla', () => {
  assert.equal(validateCoverage(null), null);
  assert.deepEqual(validateCoverage({ latitude: -1.24, longitude: -78.62, radiusKm: 2.345 }), { latitude: -1.24, longitude: -78.62, radiusKm: 2.35 });
  assert.throws(() => validateCoverage({ latitude: -1.24, longitude: -78.62, radiusKm: 0.05 }), ZoneValidationError);
  assert.throws(() => validateCoverage({ latitude: -1.24, longitude: -78.62, radiusKm: 50.1 }), ZoneValidationError);
  assert.throws(() => validateCoverage({ latitude: -1.24, longitude: -78.62 }), ZoneValidationError);
  assert.throws(() => validateCoverage({ latitude: -1.24, longitude: -78.62, radiusKm: 2, color: 'rojo' }), ZoneValidationError);
  assert.throws(() => validateCoverage([1, 2, 3]), ZoneValidationError);
});

test('Zone: expone la cobertura, decide si cubre un punto y la serializa', () => {
  const zone = Zone.create({ id: ID, name: 'Centro', createdAt: NOW, updatedAt: NOW, coverage: { latitude: -1.242, longitude: -78.628, radiusKm: 3 } });
  assert.equal(zone.covers(-1.243, -78.627), true);
  assert.equal(zone.covers(-1.21, -78.599), false);
  assert.deepEqual(zone.toJSON().coverage, { latitude: -1.242, longitude: -78.628, radiusKm: 3 });
  const plain = Zone.create({ id: ID, name: 'Sin cobertura', createdAt: NOW, updatedAt: NOW });
  assert.equal(plain.coverage, null);
  assert.equal(plain.covers(-1.242, -78.628), false);
  assert.equal(plain.toJSON().coverage, null);
});

test('validatePhone: 7 a 15 dígitos, + opcional, sin espacios ni guiones al guardar', () => {
  assert.equal(validatePhone('+593 99 123 4567'), '+593991234567');
  assert.equal(validatePhone('099-123-4567'), '0991234567');
  assert.equal(validatePhone(null), null);
  assert.equal(validatePhone(''), null);
  assert.throws(() => validatePhone('12345'), AuthError);
  assert.throws(() => validatePhone('abc1234567'), AuthError);
  assert.throws(() => validatePhone(991234567), AuthError);
});

test('firstNameOf: solo el nombre de pila del repartidor', () => {
  assert.equal(firstNameOf('Pablo Veleaaz'), 'Pablo');
  assert.equal(firstNameOf('  Ana   María '), 'Ana');
  assert.equal(firstNameOf(''), null);
  assert.equal(firstNameOf(null), null);
});

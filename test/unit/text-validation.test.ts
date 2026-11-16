import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAddressText,
  validateNewEmail,
  validatePersonName,
  validatePlaceName,
} from '../../src/shared/text-validation.js';
import { validateRegistration } from '../../src/modules/couriers/domain/courier.js';
import { validateNewDisplayName, validateNewEmail as validateNewAuthEmail } from '../../src/modules/auth/domain/auth-user.entity.js';

const ok = (result: { ok: boolean }) => assert.equal(result.ok, true);
const bad = (result: { ok: boolean }, label: string) => assert.equal(result.ok, false, label);

test('nombres de persona: acepta nombres reales con acentos, apóstrofo, guion y punto', () => {
  for (const name of ['María José', 'José Ángel Núñez', "O'Brien", 'Jean-Paul', 'Ñusta Quispe', 'Carlos Pérez Jr.', 'M. A. López', 'Zoë', 'Müller']) {
    ok(validatePersonName(name, 'El nombre'));
  }
});

test('nombres de persona: rechaza emojis, números, símbolos y texto basura', () => {
  const invalid = ['Juan 😀', '😀', 'Juan2', '123', 'K6 Smoke', 'Ana <script>', 'Ana@Pérez', '', '   ', 'A', "--", "'Ana", 'Ana--Pérez', 'Ana  ', 'Ana\u0000Pérez', 'Ana‮Pérez', 'Ana ❤️', 'x'.repeat(121)];
  for (const name of invalid) {
    const result = validatePersonName(name, 'El nombre');
    // 'Ana  ' se normaliza (espacios sobrantes) y es válido; el resto debe rechazarse.
    if (name === 'Ana  ') ok(result); else bad(result, JSON.stringify(name));
  }
  bad(validatePersonName(7, 'El nombre'), 'no texto');
});

test('nombres de persona: normaliza espacios y forma Unicode', () => {
  const result = validatePersonName('  María    José ', 'El nombre');
  assert.deepEqual(result, { ok: true, value: 'María José' });
});

test('nombres de zona: acepta letras, números y puntuación básica; rechaza emojis y símbolos', () => {
  for (const name of ['Centro', 'Zona Norte 2', 'Sector 5 (Sur)', 'La Floresta #3', 'Ambato - Centro']) ok(validatePlaceName(name, 'El nombre de la zona'));
  for (const name of ['Centro 😀', '😀😀', '12', '<b>Norte</b>', 'Norte;DROP', 'A', '', 'x'.repeat(81)]) {
    bad(validatePlaceName(name, 'El nombre de la zona'), name);
  }
});

test('direcciones: acepta direcciones reales; rechaza emojis, símbolos y control', () => {
  for (const address of ['Av. Cevallos y Montalvo #12-34', 'Calle 10 de Agosto, Edif. Sol (piso 3)', 'Km 5 ½ vía Quito'.replace('½', ''), 'Urb. San José, Mz. B Villa 7']) {
    ok(validateAddressText(address, 'La dirección'));
  }
  for (const address of ['Calle Falsa 123 😀', '😀😀😀😀😀', '12345', 'Calle <img src=x>', 'Calle\n\tFalsa 123 ok'.replace(/\s/g, '\u0007'), 'abc', 'x'.repeat(201)]) {
    bad(validateAddressText(address, 'La dirección'), address);
  }
});

test('correo nuevo: acepta formatos habituales y normaliza a minúsculas', () => {
  for (const email of ['cliente1@test.com', 'Ana.Perez+pedidos@correo.uta.edu.ec', 'a_b-c@ultima-milla.test']) ok(validateNewEmail(email));
  assert.deepEqual(validateNewEmail('  ANA@Correo.COM '), { ok: true, value: 'ana@correo.com' });
});

test('correo nuevo: rechaza emojis, acentos, espacios y formas malformadas', () => {
  const invalid = ['ana😀@correo.com', 'añá@correo.com', 'ana@correo😀.com', 'ana perez@correo.com', 'ana@@correo.com', 'ana@correo', 'ana@.com', 'ana@correo..com',
    '.ana@correo.com', 'ana.@correo.com', 'ana..perez@correo.com', 'ana@correo.c', 'ana@-correo.com', "' OR 1=1--", '', 'a'.repeat(65) + '@correo.com', `${'a'.repeat(250)}@correo.com`];
  for (const email of invalid) bad(validateNewEmail(email), email);
  bad(validateNewEmail(undefined), 'undefined');
});

test('registro de repartidor aplica la regla de nombre de persona', () => {
  assert.equal(validateRegistration('  Carlos   Pérez ', 4).displayName, 'Carlos Pérez');
  assert.throws(() => validateRegistration('Repartidor 01', 4), /números/);
  assert.throws(() => validateRegistration('Carlos 😀', 4));
});

test('auth: alta valida correo estricto y nombre opcional sin números ni emojis', () => {
  assert.equal(validateNewDisplayName(undefined), null);
  assert.equal(validateNewDisplayName('   '), null);
  assert.equal(validateNewDisplayName('Ana Pérez'), 'Ana Pérez');
  assert.throws(() => validateNewDisplayName('Ana 😀'));
  assert.throws(() => validateNewDisplayName('Admin2'));
  assert.throws(() => validateNewDisplayName(42));
  assert.equal(validateNewAuthEmail('Ana@Correo.com'), 'ana@correo.com');
  assert.throws(() => validateNewAuthEmail('ana😀@correo.com'));
});

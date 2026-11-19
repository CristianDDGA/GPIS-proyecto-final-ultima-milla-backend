import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBrandName,
  validateCategoryName,
  validateProductDescription,
  validateProductName,
  validateSearchText,
  validateSku,
} from '../../src/shared/store-text-validation.js';
import { isCleanVisibleText, validateAddressText, validatePersonName, validatePlaceName } from '../../src/shared/text-validation.js';

const ok = (result: { ok: boolean }) => result.ok === true;

// Textos que NO deben pasar nunca como nombre visible. Incluye los emojis de dígito (keycap) que antes colaban.
const KEYCAP_1 = '1️⃣';
const BAD_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['emoji de bicicleta', 'Bicicleta \u{1F6B2}'],
  ['emoji de cara', 'Hola \u{1F600} mundo'],
  ['emoji de corazón con selector de variación', 'Amor ❤️ eterno'],
  ['emoji con ZWJ (familia)', 'Familia \u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
  ['dígito keycap 1️⃣', `Set ${KEYCAP_1} piezas`],
  ['dígito keycap sin selector (5⃣)', 'Set 5⃣ piezas'],
  ['selector de variación suelto tras un dígito', 'Set 1️ piezas'],
  ['bandera (indicadores regionales)', 'Camiseta \u{1F1EA}\u{1F1E8}'],
  ['símbolo de marca registrada', 'Audifonos™ Pro'],
  ['símbolo de derechos de autor', 'Mesa © 2026'],
  ['flecha', 'Entrega → rápida'],
  ['estrella', 'Oferta ★★★'],
  ['ZWJ invisible entre letras', 'Hogar\u200Dcasa'],
  ['espacio de ancho cero', 'Hogar\u200Bcasa'],
  ['inversión de escritura', 'Zona\u202Eabc'],
  ['carácter de control', 'Mesa\u0007 grande'],
  ['letras matemáticas decorativas', '\u{1D4D7}\u{1D4F8}\u{1D4F5}\u{1D4EA} mundo'],
  ['letras de ancho completo', 'Ａｂｃ producto'],
  ['alfabeto cirílico', 'Привет mundo'],
  ['ideogramas', '漢字 producto'],
  ['texto apilado (zalgo)', 'Zó́́́na'],
  ['marca combinante sin letra', ' ́́ mesa'],
  ['etiqueta HTML', '<script>alert(1)</script>'],
  ['comillas invertidas y punto y coma', 'Mesa; DROP TABLE products'],
  ['solo números', '12345'],
  ['una sola letra', 'a'],
  ['empieza con un signo', '-Mesa grande'],
];

test('nombre de producto: acepta números, tildes y puntuación básica', () => {
  for (const name of [
    'Bandas de resistencia set 5 niveles',
    'Cámara 4K (2024) - Edición ñandú #1',
    'Audífonos inalámbricos con cancelación de ruido',
    'Alfombra 2 x 3 m',
    'Café "Premium" 500 g',
    "Müller & O'Brien 12/24",
    'Jersey nº 10',
    'Crema 50% natural + vitaminas',
    'Mesa 120 cm: roble',
  ]) {
    const result = validateProductName(name);
    assert.equal(ok(result), true, `${name} -> ${JSON.stringify(result)}`);
  }
});

test('nombre de producto: normaliza espacios y la forma compuesta de las tildes', () => {
  const result = validateProductName('  Café   molido   ');
  assert.deepEqual(result, { ok: true, value: 'Café molido' });
});

test('nombre de producto: rechaza emojis, keycaps, caracteres invisibles, otros alfabetos y símbolos', () => {
  for (const [why, text] of BAD_NAMES) {
    assert.equal(ok(validateProductName(text)), false, `debería rechazar: ${why} (${JSON.stringify(text)})`);
  }
});

test('nombre de producto: límites de largo y tipo', () => {
  assert.equal(ok(validateProductName('Ab')), true);
  assert.equal(ok(validateProductName('A'.repeat(120))), true);
  assert.equal(ok(validateProductName('A'.repeat(121))), false);
  assert.equal(ok(validateProductName('')), false);
  assert.equal(ok(validateProductName('   ')), false);
  for (const value of [null, undefined, 42, {}, [], true]) assert.equal(ok(validateProductName(value)), false);
});

test('marca y categoría aplican la misma lista blanca', () => {
  assert.equal(ok(validateBrandName('SoundMax')), true);
  assert.equal(ok(validateBrandName('Müller & Co.')), true);
  assert.equal(ok(validateBrandName('Marca \u{1F525}')), false);
  assert.equal(ok(validateBrandName(`Marca ${KEYCAP_1}`)), false);
  assert.equal(ok(validateCategoryName('Deportes y actividades al aire libre')), true);
  assert.equal(ok(validateCategoryName('Belleza y cuidado personal')), true);
  assert.equal(ok(validateCategoryName('Bebé \u{1F37C}')), false);
  assert.equal(ok(validateCategoryName('Hogar ™')), false);
  assert.equal(ok(validateCategoryName('A')), false);
});

test('descripción: conserva saltos de línea, colapsa los excesos y rechaza emojis', () => {
  assert.deepEqual(validateProductDescription('Línea uno.\r\nLínea   dos.\n\n\n\nLínea tres.'), {
    ok: true,
    value: 'Línea uno.\nLínea dos.\n\nLínea tres.',
  });
  assert.equal(ok(validateProductDescription('Cancelación de ruido activa. Batería de 30 h (aprox.) - envío gratis!')), true);
  assert.equal(ok(validateProductDescription('Muy bueno \u{1F44D}')), false);
  assert.equal(ok(validateProductDescription(`Incluye ${KEYCAP_1} cable`)), false);
  assert.equal(ok(validateProductDescription('Texto con <b>etiquetas</b>')), false);
  assert.equal(ok(validateProductDescription('x'.repeat(2001))), false);
  assert.equal(ok(validateProductDescription('   ')), false);
});

test('SKU: pasa a mayúsculas y exige el formato', () => {
  assert.deepEqual(validateSku(' aud-100 '), { ok: true, value: 'AUD-100' });
  for (const bad of ['A', 'AB', '-ABC', 'ABC-', 'A--B', 'AB CD', 'AB_CD', 'ÁBC-1', 'X'.repeat(41), 'ABC\u{1F600}', '']) {
    assert.equal(ok(validateSku(bad)), false, bad);
  }
  assert.equal(ok(validateSku('X'.repeat(40))), true);
  assert.equal(ok(validateSku(7)), false);
});

test('búsqueda: acepta texto normal y rechaza emojis, símbolos e inyecciones', () => {
  for (const q of ['audifonos', 'cámara 4k', 'a', "o'brien", 'set 5 niveles']) assert.equal(ok(validateSearchText(q)), true, q);
  for (const q of ['\u{1F6B2}', `set ${KEYCAP_1}`, '<b>', 'a; drop table x', 'x'.repeat(61), '', '%00\u0000']) {
    assert.equal(ok(validateSearchText(q)), false, JSON.stringify(q));
  }
});

test('endurecimiento: zonas, direcciones y nombres de persona ya no admiten keycaps ni texto apilado', () => {
  // Antes pasaban: las marcas combinantes se admitían en cualquier posición.
  assert.equal(ok(validatePlaceName(`Zona ${KEYCAP_1} norte`, 'La zona')), false);
  assert.equal(ok(validatePlaceName('Zona 5⃣ norte', 'La zona')), false);
  assert.equal(ok(validatePlaceName('Zó́́́na', 'La zona')), false);
  assert.equal(ok(validateAddressText(`Calle ${KEYCAP_1} y Av. Amazonas`, 'La dirección')), false);
  assert.equal(ok(validateAddressText('Calle 5⃣ y Av. Amazonas', 'La dirección')), false);
  assert.equal(ok(validatePersonName('Ana⃣ Pérez', 'El nombre')), false);
  assert.equal(ok(validatePersonName('Ana\u200D Pérez', 'El nombre')), false);
  // Lo legítimo sigue pasando.
  assert.equal(ok(validatePlaceName('Zona Norte 2', 'La zona')), true);
  assert.equal(ok(validateAddressText('Av. 9 de Octubre #123 y Malecón', 'La dirección')), true);
  assert.equal(ok(validatePersonName('José Ñandú-Pérez', 'El nombre')), true);
  assert.equal(ok(validatePersonName("María O'Connor", 'El nombre')), true);
  assert.equal(ok(validatePlaceName('Café central', 'La zona')), true);
});

test('isCleanVisibleText distingue texto limpio de texto con caracteres invisibles', () => {
  assert.equal(isCleanVisibleText('Señor Pérez, café 4K'), true);
  assert.equal(isCleanVisibleText('A\u200BB'), false);
  assert.equal(isCleanVisibleText('A️'), false);
  assert.equal(isCleanVisibleText('1⃣'), false);
  assert.equal(isCleanVisibleText('\u00ADhola'), false);
});

// Reglas de texto de la tienda. Lista blanca estricta: letras latinas (con tildes y ñ), números ASCII y
// puntuación básica. Los números SÍ se admiten en nombres de producto ("Set 5 niveles", "Cámara 4K");
// emojis, símbolos, letras de otros alfabetos y caracteres invisibles NO.
// El texto se normaliza a NFC antes de comprobarlo: las letras con tilde llegan compuestas, por eso no hace
// falta admitir marcas combinantes. La base de datos repite una lista negra como segunda barrera.
import { isCleanVisibleText, normalizeText, type TextResult } from './text-validation.js';

const LATIN = 'A-Za-zÀ-ÖØ-öø-ſ';
const PRODUCT_NAME = new RegExp(`^[${LATIN}0-9][${LATIN}0-9 .,'’&/()#+%°ºª:"“”–-]*$`);
const CATEGORY_NAME = new RegExp(`^[${LATIN}0-9][${LATIN}0-9 .,'’&/()-]*$`);
const SEARCH_TEXT = new RegExp(`^[${LATIN}0-9][${LATIN}0-9 .,'’&/()#+%-]*$`);
const DESCRIPTION = new RegExp(`^[${LATIN}0-9 \\n.,;:!?¿¡'’"“”()/&%+–—#°ºª*×=$-]+$`);
const SKU = /^[A-Z0-9][A-Z0-9-]{1,38}[A-Z0-9]$/;
const LATIN_LETTER = new RegExp(`[${LATIN}]`, 'g');

const NAME_ALLOWED = `. , ' & / ( ) # + % ° : " -`;
const CATEGORY_ALLOWED = `. , ' & / ( ) -`;
const SEARCH_ALLOWED = `. , ' & / ( ) # + % -`;

const fail = (reason: string): TextResult => ({ ok: false, reason });

function countLatinLetters(value: string): number {
  return (value.match(LATIN_LETTER) ?? []).length;
}

interface LineRules {
  readonly min: number;
  readonly max: number;
  readonly minLetters: number;
}

function checkLine(value: unknown, label: string, rules: LineRules, pattern: RegExp, allowed: string): TextResult {
  if (typeof value !== 'string') return fail(`${label} debe ser texto.`);
  const text = normalizeText(value);
  if (text.length === 0) return fail(`${label} es obligatorio.`);
  if (text.length < rules.min || text.length > rules.max) return fail(`${label} debe tener entre ${rules.min} y ${rules.max} caracteres.`);
  if (countLatinLetters(text) < rules.minLetters) return fail(`${label} debe incluir al menos ${rules.minLetters} letras.`);
  if (!isCleanVisibleText(text) || !pattern.test(text)) {
    return fail(`${label} solo admite letras, números, espacios y ${allowed}; no se permiten emojis, símbolos ni caracteres especiales.`);
  }
  return { ok: true, value: text };
}

/** Nombre de producto: 2 a 120 caracteres. Admite números. */
export function validateProductName(value: unknown, label = 'El nombre del producto'): TextResult {
  return checkLine(value, label, { min: 2, max: 120, minLetters: 2 }, PRODUCT_NAME, NAME_ALLOWED);
}

/** Marca: 2 a 60 caracteres. */
export function validateBrandName(value: unknown, label = 'La marca'): TextResult {
  return checkLine(value, label, { min: 2, max: 60, minLetters: 2 }, PRODUCT_NAME, NAME_ALLOWED);
}

/** Categoría: 2 a 60 caracteres. */
export function validateCategoryName(value: unknown, label = 'El nombre de la categoría'): TextResult {
  return checkLine(value, label, { min: 2, max: 60, minLetters: 2 }, CATEGORY_NAME, CATEGORY_ALLOWED);
}

/** Texto de búsqueda: 1 a 60 caracteres, sin emojis ni símbolos. */
export function validateSearchText(value: unknown, label = 'La búsqueda'): TextResult {
  return checkLine(value, label, { min: 1, max: 60, minLetters: 0 }, SEARCH_TEXT, SEARCH_ALLOWED);
}

/** Descripción de varias líneas: hasta 2000 caracteres; los saltos de línea se conservan (máximo 2 seguidos). */
export function validateProductDescription(value: unknown, label = 'La descripción'): TextResult {
  if (typeof value !== 'string') return fail(`${label} debe ser texto.`);
  const text = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length === 0) return fail(`${label} no puede estar vacía.`);
  if (text.length > 2000) return fail(`${label} no puede superar 2000 caracteres.`);
  if (countLatinLetters(text) < 2) return fail(`${label} debe incluir al menos 2 letras.`);
  if (!isCleanVisibleText(text.replace(/\n/g, ' ')) || !DESCRIPTION.test(text)) {
    return fail(`${label} solo admite letras, números, espacios, saltos de línea y . , ; : ! ? ¿ ¡ ' " ( ) / & % + # * × = $ -; no se permiten emojis ni símbolos.`);
  }
  return { ok: true, value: text };
}

/** SKU: se pasa a mayúsculas; 3 a 40 caracteres entre A-Z, 0-9 y guion, sin guion al inicio, al final ni doble. */
export function validateSku(value: unknown, label = 'El SKU'): TextResult {
  if (typeof value !== 'string') return fail(`${label} debe ser texto.`);
  const text = value.trim().toUpperCase();
  if (!SKU.test(text) || text.includes('--')) {
    return fail(`${label} debe tener de 3 a 40 caracteres con letras A-Z, números y guiones, sin guion al inicio ni al final.`);
  }
  return { ok: true, value: text };
}

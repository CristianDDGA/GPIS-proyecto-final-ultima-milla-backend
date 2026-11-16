// Reglas de texto compartidas para datos que escribe un usuario (nombres, correo, direcciones).
// Se usan solo al CREAR datos: la rehidratación de registros existentes no se valida con ellas.
// Lista blanca de caracteres: letras de cualquier idioma, marcas diacríticas y la puntuación mínima
// necesaria. Emojis, símbolos y caracteres de control quedan fuera por no estar en la lista.

export type TextResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

const fail = (reason: string): TextResult => ({ ok: false, reason });

// NFC unifica "é" compuesta/descompuesta; los espacios internos repetidos se colapsan.
export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function countLetters(value: string): number {
  return (value.match(/\p{L}/gu) ?? []).length;
}

const PERSON_NAME = /^\p{L}[\p{L}\p{M}]*(?:(?:\.? |['’-])\p{L}[\p{L}\p{M}]*)*\.?$/u;

/** Nombre o apellido de una persona: solo letras, espacios, apóstrofo, guion y punto. Sin números ni emojis. */
export function validatePersonName(value: unknown, label: string): TextResult {
  if (typeof value !== 'string') return fail(`${label} debe ser texto.`);
  const text = normalizeText(value);
  if (text.length === 0) return fail(`${label} es obligatorio.`);
  if (text.length > 120) return fail(`${label} no puede superar 120 caracteres.`);
  if (countLetters(text) < 2) return fail(`${label} debe tener al menos 2 letras.`);
  if (!PERSON_NAME.test(text)) {
    return fail(`${label} solo admite letras, espacios, apóstrofo, guion y punto; no se permiten números, emojis ni símbolos.`);
  }
  return { ok: true, value: text };
}

const PLACE_NAME = /^[\p{L}0-9][\p{L}\p{M}0-9 .,'’&/()#-]*$/u;

/** Nombre de zona: letras y números, con puntuación básica. Sin emojis ni símbolos. */
export function validatePlaceName(value: unknown, label: string): TextResult {
  if (typeof value !== 'string') return fail(`${label} debe ser texto.`);
  const text = normalizeText(value);
  if (text.length === 0) return fail(`${label} es obligatorio.`);
  if (text.length < 2 || text.length > 80) return fail(`${label} debe tener entre 2 y 80 caracteres.`);
  if (countLetters(text) < 2) return fail(`${label} debe incluir al menos 2 letras.`);
  if (!PLACE_NAME.test(text)) {
    return fail(`${label} solo admite letras, números, espacios y . , ' & / ( ) # -; no se permiten emojis ni símbolos.`);
  }
  return { ok: true, value: text };
}

const ADDRESS = /^[\p{L}0-9][\p{L}\p{M}0-9 .,'’&/()#°º-]*$/u;

/** Dirección de entrega: letras, números y puntuación de direcciones. Sin emojis ni caracteres de control. */
export function validateAddressText(value: unknown, label: string): TextResult {
  if (typeof value !== 'string') return fail(`${label} debe ser texto.`);
  const text = normalizeText(value);
  if (text.length === 0) return fail(`${label} no puede estar vacía.`);
  if (text.length < 5 || text.length > 200) return fail(`${label} debe tener entre 5 y 200 caracteres.`);
  if (countLetters(text) < 2) return fail(`${label} debe incluir al menos 2 letras.`);
  if (!ADDRESS.test(text)) {
    return fail(`${label} solo admite letras, números, espacios y . , ' & / ( ) # ° º -; no se permiten emojis ni símbolos.`);
  }
  return { ok: true, value: text };
}

const EMAIL_LOCAL = /^[a-z0-9]+(?:[._%+-][a-z0-9]+)*$/;
const EMAIL_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_TLD = /^[a-z]{2,24}$/;

/** Correo nuevo: solo ASCII (sin emojis ni acentos), con dominio y TLD válidos. Se normaliza a minúsculas. */
export function validateNewEmail(value: unknown): TextResult {
  if (typeof value !== 'string') return fail('El correo electrónico es obligatorio.');
  const text = value.trim().toLowerCase();
  const invalid = fail('El formato del correo electrónico no es válido. Usa letras, números y . _ % + - sin emojis ni espacios.');
  if (text.length === 0 || text.length > 254) return invalid;
  const parts = text.split('@');
  if (parts.length !== 2) return invalid;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || local.length > 64 || !EMAIL_LOCAL.test(local)) return invalid;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => EMAIL_LABEL.test(label))) return invalid;
  if (!EMAIL_TLD.test(labels[labels.length - 1] ?? '')) return invalid;
  return { ok: true, value: text };
}

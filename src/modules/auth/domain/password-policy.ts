import { AuthError } from './auth.errors.js';
import { validatePassword } from './auth-user.entity.js';

// Contraseñas que aparecen en todas las listas de claves filtradas, en minúsculas.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '123123123', '11111111', '00000000', '87654321', '12341234',
  'qwertyui', 'qwerty123', 'qwertyuiop', 'qwerty12', '1q2w3e4r', '1qaz2wsx', 'abc12345', 'abcd1234', 'abcdefgh',
  'iloveyou', 'admin123', 'admin1234', 'administrator', 'welcome1', 'welcome123', 'letmein1', 'monkey123',
  'dragon123', 'football1', 'baseball1', 'superman1', 'sunshine1', 'princess1', 'changeme', 'changeme123',
  'contrasena', 'contrasena1', 'contrasena123', 'clave1234', 'clave12345', 'bienvenido', 'bienvenido1',
  'usuario123', 'test1234', 'ecuador123', 'ambato123', 'uta12345',
]);

// Palabras base: "Password2026!" o "Admin#1" son la misma clave débil con adornos.
const WEAK_BASE_WORDS = new Set(['password', 'contrasena', 'contraseña', 'qwerty', 'admin', 'administrator', 'welcome', 'letmein', 'clave', 'bienvenido', 'usuario', 'iloveyou']);
const MAX_DECORATION = 6;

const WEAK = 'La contraseña es demasiado común o fácil de adivinar. Usa una frase o combinación más larga y única.';

/**
 * Contraseña nueva (registro, cambio o recuperación). Mantiene el largo de validatePassword (8 a 128) y rechaza las
 * claves de lista, de un solo carácter, solo numéricas, el propio correo o variaciones triviales de palabras débiles.
 * No exige mezclar mayúsculas, números y símbolos: el largo y no ser predecible importan más.
 */
export function validateNewPassword(value: unknown, email?: string): string {
  const password = validatePassword(value);
  const lower = password.toLowerCase();
  const letters = lower.replace(/[^a-záéíóúñ]/g, '');
  const localPart = email?.split('@')[0]?.toLowerCase() ?? '';

  if (new Set(lower).size < 3) throw new AuthError('VALIDATION_ERROR', WEAK);
  if (/^\d+$/.test(password)) {
    throw new AuthError('VALIDATION_ERROR', 'La contraseña no puede ser solo números.');
  }
  if (COMMON_PASSWORDS.has(lower)) throw new AuthError('VALIDATION_ERROR', WEAK);
  if (WEAK_BASE_WORDS.has(letters) && lower.length <= letters.length + MAX_DECORATION) {
    throw new AuthError('VALIDATION_ERROR', WEAK);
  }
  if (email && (lower === email.toLowerCase() || (localPart.length >= 4 && lower.includes(localPart)))) {
    throw new AuthError('VALIDATION_ERROR', 'La contraseña no puede contener tu correo electrónico.');
  }
  return password;
}

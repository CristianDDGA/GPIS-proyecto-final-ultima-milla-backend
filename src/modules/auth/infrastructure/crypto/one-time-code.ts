import { createHmac, randomInt } from 'node:crypto';

/** Código de 6 dígitos con CSPRNG (con ceros a la izquierda). */
export function generateOneTimeCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Clave dedicada a los códigos, derivada del secreto JWT: una filtración de la tabla de códigos
 * no permite reconstruirlos sin el secreto, y la clave no sirve para firmar tokens.
 */
export function deriveCodeKey(jwtSecret: string): string {
  return createHmac('sha256', jwtSecret).update('email-code-key-v1').digest('hex');
}

/** Hash que se guarda en PostgreSQL. Incluye usuario y propósito: un código no vale para otra cuenta ni otro fin. */
export function hashOneTimeCode(codeKey: string, userId: string, purpose: string, code: string): string {
  return createHmac('sha256', codeKey).update(`${userId}:${purpose}:${code}`).digest('hex');
}

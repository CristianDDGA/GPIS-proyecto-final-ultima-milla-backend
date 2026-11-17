/**
 * Código SQLSTATE de un error de Prisma ($queryRaw con el adaptador pg).
 * El código real (p. ej. 23505, unicidad) llega en meta.driverAdapterError.cause.originalCode;
 * el `code` de nivel superior es solo el de Prisma (P2010) y no sirve para distinguir el error.
 */
export function getSqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  const original = candidate.meta?.driverAdapterError?.cause?.originalCode;
  if (typeof original === 'string') return original;
  if (typeof candidate.meta?.code === 'string') return candidate.meta.code;
  if (typeof candidate.code === 'string') return candidate.code;
  return undefined;
}

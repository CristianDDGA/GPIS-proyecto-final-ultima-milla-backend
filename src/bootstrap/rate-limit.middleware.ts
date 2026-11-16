import type { RequestHandler } from 'express';

export interface RateLimitOptions {
  /** Solicitudes permitidas por ventana, por cliente y por ruta. */
  readonly maxRequests: number;
  readonly windowMs: number;
  /** Rutas POST limitadas (path exacto, sin barra final). */
  readonly paths: ReadonlyArray<string>;
  readonly now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_TRACKED_KEYS = 10_000;

// Limitador de ventana fija en memoria: suficiente para una sola instancia de la API.
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? Date.now;
  const paths = new Set(options.paths);
  const buckets = new Map<string, Bucket>();

  function purge(current: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= current) buckets.delete(key);
    }
    // Defensa ante barridos de IPs: si sigue lleno, se descarta lo más antiguo.
    while (buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  return (request, response, next) => {
    const path = request.path.replace(/\/+$/, '') || '/';
    if (request.method !== 'POST' || !paths.has(path)) {
      next();
      return;
    }

    const current = now();
    const key = `${request.ip ?? 'unknown'}|${path}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      if (!bucket && buckets.size >= MAX_TRACKED_KEYS) purge(current);
      bucket = { count: 0, resetAt: current + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > options.maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - current) / 1000));
      const code = 'TOO_MANY_REQUESTS';
      const message = 'Demasiados intentos. Intenta nuevamente más tarde.';
      response.setHeader('Retry-After', String(retryAfter));
      response.status(429).json({ code, message, error: { code, message } });
      return;
    }
    next();
  };
}

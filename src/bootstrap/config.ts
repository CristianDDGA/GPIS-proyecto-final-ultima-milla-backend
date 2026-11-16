export interface AppConfig {
  readonly port: number;
  readonly webOrigin: string;
  readonly databaseUrl?: string;
  readonly jwtSecret: string;
  readonly jwtExpiresInSeconds: number;
  readonly authRateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly trustProxyHops?: number;
}

const JWT_SECRET_MIN_LENGTH = 32;
const JWT_SECRET_HELP =
  "Genera uno con: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\" y guárdalo en .env (nunca en Git).";
// Secretos que estuvieron en el código o en ejemplos públicos: cualquiera podría falsificar tokens con ellos.
const KNOWN_INSECURE_SECRETS = new Set(['dev-only-jwt-secret-change-in-prod']);

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const port = Number(environment.PORT ?? '3000');
  const webOrigin = environment.WEB_ORIGIN ?? 'http://127.0.0.1:5173';

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT debe ser un entero entre 1 y 65535.');
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(webOrigin);
  } catch {
    throw new Error('WEB_ORIGIN debe ser un origen HTTP/HTTPS válido.');
  }

  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== webOrigin) {
    throw new Error('WEB_ORIGIN debe contener únicamente el origen HTTP/HTTPS, sin ruta.');
  }

  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl) {
    let parsedDatabase: URL;
    try { parsedDatabase = new URL(databaseUrl); } catch {
      throw new Error('DATABASE_URL debe ser una conexión PostgreSQL válida.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsedDatabase.protocol) || parsedDatabase.username !== 'logistica_app') {
      throw new Error('La API requiere una conexión PostgreSQL con el rol logistica_app.');
    }
  }

  const jwtSecret = environment.JWT_SECRET;
  if (jwtSecret === undefined || jwtSecret.trim() === '') {
    throw new Error(`JWT_SECRET es obligatorio. ${JWT_SECRET_HELP}`);
  }
  if (jwtSecret.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(`JWT_SECRET debe tener al menos ${JWT_SECRET_MIN_LENGTH} caracteres. ${JWT_SECRET_HELP}`);
  }
  if (KNOWN_INSECURE_SECRETS.has(jwtSecret) || /^REEMPLAZAR/i.test(jwtSecret)) {
    throw new Error(`JWT_SECRET no puede ser un valor de ejemplo ni el secreto público de desarrollo. ${JWT_SECRET_HELP}`);
  }

  const jwtExpiresInSeconds = Number(environment.JWT_EXPIRES_IN_SECONDS ?? '86400');
  if (!Number.isInteger(jwtExpiresInSeconds) || jwtExpiresInSeconds < 60) {
    throw new Error('JWT_EXPIRES_IN_SECONDS debe ser un entero mayor o igual a 60.');
  }

  const authRateLimitMax = Number(environment.AUTH_RATE_LIMIT_MAX ?? '20');
  const authRateLimitWindowMs = Number(environment.AUTH_RATE_LIMIT_WINDOW_MS ?? '60000');
  if (!Number.isInteger(authRateLimitMax) || authRateLimitMax < 1) {
    throw new Error('AUTH_RATE_LIMIT_MAX debe ser un entero mayor o igual a 1.');
  }
  if (!Number.isInteger(authRateLimitWindowMs) || authRateLimitWindowMs < 1_000) {
    throw new Error('AUTH_RATE_LIMIT_WINDOW_MS debe ser un entero mayor o igual a 1000.');
  }

  // TRUST_PROXY = número de proxies delante de la API (p. ej. 1). Vacío = no confiar en X-Forwarded-For.
  let trustProxyHops: number | undefined;
  if (environment.TRUST_PROXY !== undefined && environment.TRUST_PROXY !== '') {
    trustProxyHops = Number(environment.TRUST_PROXY);
    if (!Number.isInteger(trustProxyHops) || trustProxyHops < 1 || trustProxyHops > 10) {
      throw new Error('TRUST_PROXY debe ser un entero entre 1 y 10.');
    }
  }

  return {
    port,
    ...(trustProxyHops !== undefined ? { trustProxyHops } : {}),
    webOrigin,
    jwtSecret,
    jwtExpiresInSeconds,
    authRateLimit: { maxRequests: authRateLimitMax, windowMs: authRateLimitWindowMs },
    ...(databaseUrl ? { databaseUrl } : {}),
  };
}

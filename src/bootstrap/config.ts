import { DEFAULT_JWT_EXPIRES_IN_SECONDS } from '../modules/auth/index.js';
import type { SmtpConfig } from '../modules/auth/infrastructure/email/smtp-email-sender.js';

export interface AppConfig {
  readonly port: number;
  readonly webOrigin: string;
  readonly databaseUrl?: string;
  readonly jwtSecret: string;
  readonly jwtExpiresInSeconds: number;
  readonly authRateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly trustProxyHops?: number;
  /** Carpeta privada donde se guardan las imágenes de las solicitudes de conductor. */
  readonly courierUploadsDir: string;
  readonly loginLockout: { readonly maxFailures: number; readonly lockSeconds: number };
  /** false = modo demo (sin verificación ni SMTP para clientes). */
  readonly emailVerificationRequired: boolean;
  /** console = los correos se escriben en la salida estándar (solo desarrollo). */
  readonly mail: { readonly transport: 'console' } | { readonly transport: 'smtp'; readonly smtp: SmtpConfig };
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

  const jwtExpiresInSeconds = Number(environment.JWT_EXPIRES_IN_SECONDS ?? String(DEFAULT_JWT_EXPIRES_IN_SECONDS));
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

  // Bloqueo por cuenta: LOGIN_MAX_FAILED_ATTEMPTS fallos en 15 minutos bloquean la cuenta LOGIN_LOCK_SECONDS.
  const loginMaxFailures = Number(environment.LOGIN_MAX_FAILED_ATTEMPTS ?? '5');
  const loginLockSeconds = Number(environment.LOGIN_LOCK_SECONDS ?? '300');
  if (!Number.isInteger(loginMaxFailures) || loginMaxFailures < 3 || loginMaxFailures > 100) {
    throw new Error('LOGIN_MAX_FAILED_ATTEMPTS debe ser un entero entre 3 y 100.');
  }
  if (!Number.isInteger(loginLockSeconds) || loginLockSeconds < 30 || loginLockSeconds > 86_400) {
    throw new Error('LOGIN_LOCK_SECONDS debe ser un entero entre 30 y 86400.');
  }

  // TRUST_PROXY = número de proxies delante de la API (p. ej. 1). Vacío = no confiar en X-Forwarded-For.
  let trustProxyHops: number | undefined;
  if (environment.TRUST_PROXY !== undefined && environment.TRUST_PROXY !== '') {
    trustProxyHops = Number(environment.TRUST_PROXY);
    if (!Number.isInteger(trustProxyHops) || trustProxyHops < 1 || trustProxyHops > 10) {
      throw new Error('TRUST_PROXY debe ser un entero entre 1 y 10.');
    }
  }

  // Modo demo: EMAIL_VERIFICATION_REQUIRED=false deja a los clientes verificados al registrarse y no usa SMTP.
  const verificationFlag = (environment.EMAIL_VERIFICATION_REQUIRED ?? 'true').trim().toLowerCase();
  if (verificationFlag !== 'true' && verificationFlag !== 'false') {
    throw new Error('EMAIL_VERIFICATION_REQUIRED debe ser true o false.');
  }
  const emailVerificationRequired = verificationFlag === 'true';

  let mail: AppConfig['mail'] = { transport: 'console' };
  const smtpHost = environment.SMTP_HOST?.trim();
  if (smtpHost) {
    const smtpPort = Number(environment.SMTP_PORT ?? '587');
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
      throw new Error('SMTP_PORT debe ser un entero entre 1 y 65535.');
    }
    const from = environment.MAIL_FROM?.trim();
    if (!from) {
      throw new Error('MAIL_FROM es obligatorio cuando se configura SMTP_HOST (por ejemplo: "Última Milla <no-reply@tudominio.com>").');
    }
    const user = environment.SMTP_USER?.trim();
    mail = {
      transport: 'smtp',
      smtp: {
        host: smtpHost,
        port: smtpPort,
        secure: (environment.SMTP_SECURE ?? (smtpPort === 465 ? 'true' : 'false')).trim().toLowerCase() === 'true',
        from,
        ...(user ? { user, password: environment.SMTP_PASS ?? '' } : {}),
      },
    };
  } else if (environment.NODE_ENV === 'production' && emailVerificationRequired) {
    throw new Error('En producción, con verificación de correo activa, SMTP_HOST es obligatorio.');
  }

  return {
    port,
    emailVerificationRequired,
    mail,
    loginLockout: { maxFailures: loginMaxFailures, lockSeconds: loginLockSeconds },
    courierUploadsDir: environment.COURIER_UPLOADS_DIR?.trim() || './storage/courier-applications',
    ...(trustProxyHops !== undefined ? { trustProxyHops } : {}),
    webOrigin,
    jwtSecret,
    jwtExpiresInSeconds,
    authRateLimit: { maxRequests: authRateLimitMax, windowMs: authRateLimitWindowMs },
    ...(databaseUrl ? { databaseUrl } : {}),
  };
}

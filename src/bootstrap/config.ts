export interface AppConfig {
  readonly port: number;
  readonly webOrigin: string;
  readonly databaseUrl?: string;
  readonly jwtSecret: string;
  readonly jwtExpiresInSeconds: number;
}

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

  const rawSecret = environment.JWT_SECRET;
  if (rawSecret !== undefined && rawSecret.length < 16) {
    throw new Error('JWT_SECRET debe tener al menos 16 caracteres.');
  }
  if (rawSecret === undefined && environment.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET es obligatorio en producción.');
  }
  const jwtSecret = rawSecret ?? 'dev-only-jwt-secret-change-in-prod';

  const jwtExpiresInSeconds = Number(environment.JWT_EXPIRES_IN_SECONDS ?? '86400');
  if (!Number.isInteger(jwtExpiresInSeconds) || jwtExpiresInSeconds < 60) {
    throw new Error('JWT_EXPIRES_IN_SECONDS debe ser un entero mayor o igual a 60.');
  }

  return { port, webOrigin, jwtSecret, jwtExpiresInSeconds, ...(databaseUrl ? { databaseUrl } : {}) };
}

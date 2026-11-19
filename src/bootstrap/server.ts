import { createApp } from './create-app.js';
import { loadConfig } from './config.js';
import { createDatabaseClient } from './database.js';
import { createPersistedApp } from './create-persisted-app.js';
import { ConsoleEmailSender } from '../modules/auth/infrastructure/email/console-email-sender.js';
import { createJsonSecurityLog } from '../modules/auth/infrastructure/logging/json-security-log.js';
import { SmtpEmailSender } from '../modules/auth/infrastructure/email/smtp-email-sender.js';
import { createStorages } from './storage.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
const database = config.databaseUrl ? createDatabaseClient(config.databaseUrl) : undefined;
if (database) {
  try { await database.$connect(); }
  catch {
    await database.$disconnect();
    throw new Error('No se pudo conectar PostgreSQL. Revisa Docker y DATABASE_URL.');
  }
}
const storages = createStorages(config);
let notificationWorker: { start(): void; stop(): void } | undefined;
const app = database
  ? createPersistedApp(database, config.webOrigin, {
      jwtSecret: config.jwtSecret,
      jwtExpiresInSeconds: config.jwtExpiresInSeconds,
      authRateLimit: config.authRateLimit,
      emailVerificationRequired: config.emailVerificationRequired,
      loginLockout: config.loginLockout,
      fileStorage: storages.courierStorage,
      productImageStorage: storages.productImages,
      securityLog: createJsonSecurityLog(),
      onNotificationWorker: (worker) => { notificationWorker = worker; },
      emailSender: config.mail.transport === 'smtp' ? new SmtpEmailSender(config.mail.smtp) : new ConsoleEmailSender(),
      ...(config.trustProxyHops !== undefined ? { trustProxyHops: config.trustProxyHops } : {}),
    })
  : createApp({ webOrigin: config.webOrigin });
const server = app.listen(config.port, () => {
  notificationWorker?.start();
  process.stdout.write(`API unificada escuchando en http://localhost:${config.port}\n`);
  process.stdout.write(
    database
      ? 'PostgreSQL conectado: zonas, pedidos, rutas, operaciones de ruta, repartidores, entregas y tienda habilitados en un solo puerto.\n'
      : 'Sin DATABASE_URL: solo /health habilitado.\n',
  );
});
if (database && config.storage.driver === 'disk' && process.env['NODE_ENV'] === 'production') {
  process.stderr.write(
    'AVISO: STORAGE_DRIVER=disk en producción. En un hosting con disco efímero (Render) las imágenes se pierden al reiniciar; usa STORAGE_DRIVER=supabase.\n',
  );
}
if (database && process.env['NODE_ENV'] === 'production' && config.emailVerificationRequired && config.mail.transport !== 'smtp') {
  process.stderr.write(
    'AVISO: EMAIL_VERIFICATION_REQUIRED=true sin SMTP_HOST en producción. Los códigos de verificación solo se escriben en el registro del servidor y los clientes no podrán confirmar su correo. Configura SMTP_* o, solo para una demo, EMAIL_VERIFICATION_REQUIRED=false.\n',
  );
}
// headersTimeout debe superar keepAliveTimeout para evitar cortes de conexiones reutilizadas.
server.requestTimeout = 15_000;
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  notificationWorker?.stop();
  process.exitCode = exitCode;
  // Si el cierre ordenado se cuelga (conexiones abiertas), se fuerza la salida.
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  server.close((error) => {
    if (error) process.exitCode = 1;
    void (database?.$disconnect() ?? Promise.resolve())
      .catch(() => { process.exitCode = 1; })
      .finally(() => process.exit(process.exitCode ?? 0));
  });
  server.closeIdleConnections();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown(0));
}
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  shutdown(1);
});
process.on('uncaughtException', (error) => {
  process.stderr.write(`uncaughtException: ${error.stack ?? error.message}\n`);
  shutdown(1);
});
server.on('error', () => {
  process.stderr.write('No se pudo iniciar el servidor HTTP; revisa el puerto configurado.\n');
  process.exitCode = 1;
  void database?.$disconnect().catch(() => { process.exitCode = 1; });
});

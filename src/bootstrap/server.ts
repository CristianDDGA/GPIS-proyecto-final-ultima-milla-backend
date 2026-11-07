import { createApp } from './create-app.js';
import { loadConfig } from './config.js';
import { createDatabaseClient } from './database.js';
import { createPersistedApp } from './create-persisted-app.js';

const config = loadConfig(process.env);
const database = config.databaseUrl ? createDatabaseClient(config.databaseUrl) : undefined;
if (database) {
  try { await database.$connect(); }
  catch {
    await database.$disconnect();
    throw new Error('No se pudo conectar PostgreSQL. Revisa Docker y DATABASE_URL.');
  }
}
const app = database ? createPersistedApp(database, config.webOrigin) : createApp({ webOrigin: config.webOrigin });
const server = app.listen(config.port, () => {
  process.stdout.write(`API escuchando en http://localhost:${config.port}\n`);
  process.stdout.write(database ? 'PostgreSQL conectado: zonas y pedidos habilitados.\n' : 'Sin DATABASE_URL: solo /health habilitado.\n');
});
for (const signal of ['SIGINT','SIGTERM'] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) process.exitCode=1;
      void database?.$disconnect().catch(() => { process.exitCode=1; });
    });
  });
}
server.on('error', () => {
  process.stderr.write('No se pudo iniciar el servidor HTTP; revisa el puerto configurado.\n');
  process.exitCode=1;
  void database?.$disconnect().catch(() => { process.exitCode=1; });
});

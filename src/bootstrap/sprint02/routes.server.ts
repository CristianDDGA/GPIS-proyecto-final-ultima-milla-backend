import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createApp } from '../create-app.js';
import { loadConfig } from '../config.js';
import { createDatabaseClient } from '../database.js';
import type { PrismaQueryClient } from '../../infrastructure/postgres/prisma-client.port.js';
import { createRoutesModule } from '../../modules/routes/index.js';
import { PrismaRouteRepository } from '../../modules/routes/infrastructure/postgres/prisma-route.repository.js';

// Factory for Supertest and the demo: mounts only Routes on the shared createApp.
export function createRoutesApp(database: PrismaQueryClient, webOrigin: string) {
  const routes = createRoutesModule(new PrismaRouteRepository(database));
  const app = createApp({ webOrigin, routers: routes.routers });
  app.use(routes.errorHandler);
  return app;
}

function routesPort(environment: NodeJS.ProcessEnv): number {
  const port = Number(environment['S2_ROUTES_PORT'] ?? '3011');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('S2_ROUTES_PORT debe ser un entero entre 1 y 65535.');
  }
  return port;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (!config.databaseUrl) throw new Error('Routes requiere DATABASE_URL con el rol logistica_app.');
  const port = routesPort(process.env);
  const database = createDatabaseClient(config.databaseUrl);
  try { await database.$connect(); }
  catch {
    await database.$disconnect();
    throw new Error('No se pudo conectar PostgreSQL. Revisa Docker y DATABASE_URL.');
  }
  const server = createRoutesApp(database, config.webOrigin).listen(port, () => {
    process.stdout.write(`Routes (Sprint 02) escuchando en http://localhost:${port}\n`);
  });
  server.on('error', () => {
    process.stderr.write('No se pudo iniciar el servidor HTTP de Routes; revisa S2_ROUTES_PORT.\n');
    process.exitCode = 1;
    void database.$disconnect().catch(() => { process.exitCode = 1; });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close((error) => {
        if (error) process.exitCode = 1;
        void database.$disconnect().catch(() => { process.exitCode = 1; });
      });
    });
  }
}

// Importing this file (tests) never listens; running it directly starts the demo server.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

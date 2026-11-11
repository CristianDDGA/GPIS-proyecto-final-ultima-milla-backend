import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createApp } from '../create-app.js';
import { createDatabaseClient } from '../database.js';
import type { ActorContextPort } from '../../modules/deliveries/application/ports/actor-context.port.js';
import type { DeliveryRepository } from '../../modules/deliveries/application/ports/delivery.repository.js';
import { validateActorId } from '../../modules/deliveries/domain/actor.js';
import { createDeliveriesModule } from '../../modules/deliveries/index.js';
import { StaticActorContext } from '../../modules/deliveries/infrastructure/context/static-actor.context.js';
import { PrismaDeliveryRepository } from '../../modules/deliveries/infrastructure/postgres/prisma-delivery.repository.js';

export interface DeliveriesAppDependencies {
  readonly repository: DeliveryRepository;
  readonly actorContext: ActorContextPort;
  readonly webOrigin: string;
}

export function createDeliveriesApp(dependencies: DeliveriesAppDependencies) {
  const module = createDeliveriesModule({
    repository: dependencies.repository,
    actorContext: dependencies.actorContext,
  });
  const app = createApp({
    webOrigin: dependencies.webOrigin,
    routers: [{ basePath: '/', router: module.router }],
  });
  app.use(module.errorHandler);
  return app;
}

function resolvePort(environment: NodeJS.ProcessEnv): number {
  const rawPort = environment['S3_DELIVERIES_PORT'] ?? '3013';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('S3_DELIVERIES_PORT inválido.');
  }
  return port;
}

function resolveServerActor(environment: NodeJS.ProcessEnv): ActorContextPort {
  const rawActorId = environment['S3_DELIVERIES_ACTOR_ID'];
  if (!rawActorId) {
    return new StaticActorContext(null);
  }
  return new StaticActorContext(validateActorId(rawActorId));
}

export async function startDeliveriesServer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const port = resolvePort(environment);
  const url = environment['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL es obligatorio.');
  }
  const actorContext = resolveServerActor(environment);
  const database = createDatabaseClient(url);
  try {
    await database.$connect();
  } catch {
    await database.$disconnect();
    throw new Error('No se pudo conectar PostgreSQL.');
  }

  const app = createDeliveriesApp({
    repository: new PrismaDeliveryRepository(database),
    actorContext,
    webOrigin: environment['WEB_ORIGIN'] ?? 'http://localhost:5173',
  });

  const server = app.listen(port, () =>
    process.stdout.write(`Deliveries escuchando en http://localhost:${port}\n`),
  );

  const shutdown = () => {
    server.close(() => {
      void database.$disconnect().catch(() => {
        process.exitCode = 1;
      });
    });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, shutdown);
  }
  server.on('error', () => {
    process.stderr.write('No se pudo iniciar Deliveries; revise el puerto.\n');
    process.exitCode = 1;
    void database.$disconnect();
  });
  server.on('close', () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.removeListener(signal, shutdown);
    }
  });

  return { server, database };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await startDeliveriesServer().catch(() => {
    process.stderr.write(
      'No se pudo iniciar Deliveries; revise configuración y PostgreSQL.\n',
    );
    process.exitCode = 1;
  });
}

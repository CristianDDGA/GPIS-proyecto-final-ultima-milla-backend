import { pathToFileURL } from 'node:url';
import { createApp } from '../create-app.js';
import { createDatabaseClient } from '../database.js';
import { createCouriersModule } from '../../modules/couriers/index.js';
import type { CourierRepository } from '../../modules/couriers/application/ports/courier.repository.js';
import type { AssignmentRepository } from '../../modules/couriers/application/ports/assignment.repository.js';
import { PrismaCourierRepository } from '../../modules/couriers/infrastructure/postgres/prisma-courier.repository.js';
import { PrismaAssignmentRepository } from '../../modules/couriers/infrastructure/postgres/prisma-assignment.repository.js';
export function createCouriersApp(dependencies: { couriers: CourierRepository; assignments: AssignmentRepository; webOrigin: string }) {
  const module = createCouriersModule(dependencies);
  const app = createApp({ webOrigin: dependencies.webOrigin, routers: [{ basePath: '/', router: module.router }] });
  app.use(module.errorHandler);
  return app;
}
export async function startCouriersServer(environment: NodeJS.ProcessEnv = process.env) {
  const rawPort = environment['S2_COURIERS_PORT'] ?? '3012';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('S2_COURIERS_PORT inválido.');
  const url = environment['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL es obligatorio.');
  const database = createDatabaseClient(url);
  try { await database.$connect(); }
  catch { await database.$disconnect(); throw new Error('No se pudo conectar PostgreSQL.'); }
  const app = createCouriersApp({ couriers: new PrismaCourierRepository(database), assignments: new PrismaAssignmentRepository(database), webOrigin: environment['WEB_ORIGIN'] ?? 'http://localhost:5173' });
  const server = app.listen(port, () => process.stdout.write(`Couriers escuchando en http://localhost:${port}\n`));
  const shutdown = () => { server.close(() => { void database.$disconnect().catch(() => { process.exitCode = 1; }); }); };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown);
  server.on('error', () => { process.stderr.write('No se pudo iniciar Couriers; revise el puerto.\n'); process.exitCode = 1; void database.$disconnect(); });
  server.on('close', () => { for (const signal of ['SIGINT', 'SIGTERM'] as const) process.removeListener(signal, shutdown); });
  return { server, database };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startCouriersServer().catch(() => { process.stderr.write('No se pudo iniciar Couriers; revise configuración y PostgreSQL.\n'); process.exitCode = 1; });
}

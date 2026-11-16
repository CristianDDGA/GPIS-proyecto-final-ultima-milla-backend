import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// A single factory; bootstrap shares its one client between both repositories.
export function createDatabaseClient(connectionString: string): PrismaClient {
  const configured = Number(process.env['DB_POOL_MAX'] ?? 25);
  const max = Number.isInteger(configured) && configured > 0 ? configured : 25;
  // Ajustable para planificaciones de alto volumen (generate_routes) sin recompilar.
  const configuredTimeout = Number(process.env['DB_STATEMENT_TIMEOUT_MS'] ?? 10_000);
  const statementTimeout = Number.isInteger(configuredTimeout) && configuredTimeout >= 1_000 ? configuredTimeout : 10_000;
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: statementTimeout,
    }),
  });
}

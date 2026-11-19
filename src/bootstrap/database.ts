import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { resolveDatabaseOptions } from './database-options.js';

// A single factory; bootstrap shares its one client between both repositories.
export function createDatabaseClient(connectionString: string): PrismaClient {
  const options = resolveDatabaseOptions(connectionString, process.env);
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: options.connectionString,
      max: options.max,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      ...(options.statementTimeoutMs !== undefined ? { statement_timeout: options.statementTimeoutMs } : {}),
      ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
    }),
  });
}

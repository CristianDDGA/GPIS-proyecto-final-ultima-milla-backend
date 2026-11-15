import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// A single factory; bootstrap shares its one client between both repositories.
export function createDatabaseClient(connectionString: string): PrismaClient {
  const configured = Number(process.env['DB_POOL_MAX'] ?? 25);
  const max = Number.isInteger(configured) && configured > 0 ? configured : 25;
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max, connectionTimeoutMillis: 5_000 }),
  });
}

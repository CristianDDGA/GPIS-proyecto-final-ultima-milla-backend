import type { OrderZonePort } from '../../application/ports/order-zone.port.js';
import type { PrismaOrderQueryClient } from './prisma-order.repository.js';
import { throwOrderPersistenceError } from './order-persistence.errors.js';

export class PrismaOrderZoneLookup implements OrderZonePort {
  constructor(private readonly prisma: PrismaOrderQueryClient) {}

  async findById(id: string) {
    try {
      const rows = await this.prisma.$queryRaw<readonly { id: string; active: boolean; hasCoverage: boolean }[]>`
        SELECT id, is_active AS active, (center_latitude IS NOT NULL) AS "hasCoverage" FROM logistica.zones WHERE id = ${id}::uuid`;
      return rows[0] ?? null;
    } catch (error: unknown) {
      throwOrderPersistenceError(error);
    }
  }
}

import type { PrismaDatabaseClient, PrismaQueryClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { CourierRepository, CourierPage } from '../../application/ports/courier.repository.js';
import { CourierError } from '../../domain/courier.errors.js';
import { mapCourier, type CourierRecord } from './courier.mapper.js';
import { persistenceError } from './persistence-error.js';
export async function getCourier(client: PrismaQueryClient, id: string) {
  const rows = await client.$queryRaw<CourierRecord[]>`SELECT id,display_name,max_orders_per_trip,is_enabled,is_available,created_at,updated_at FROM logistica.couriers WHERE id=${id}::uuid`;
  if (!rows[0]) throw new CourierError('COURIER_NOT_FOUND');
  return mapCourier(rows[0]);
}
export class PrismaCourierRepository implements CourierRepository {
  constructor(private readonly database: PrismaDatabaseClient) {}
  async create(input: { displayName: string; maxOrdersPerTrip: number }) {
    try {
      return await this.database.$transaction(async client => {
        const rows = await client.$queryRaw<{ id: string }[]>`SELECT logistica.create_courier(${input.displayName}::text,${input.maxOrdersPerTrip}::integer,NULL::uuid) AS id`;
        if (!rows[0]) throw new CourierError('PERSISTENCE_UNAVAILABLE');
        return getCourier(client, rows[0].id);
      });
    } catch (error: unknown) { persistenceError(error); }
  }
  async list(page: CourierPage) {
    try {
      const rows = await this.database.$queryRaw<CourierRecord[]>`
        SELECT c.id,c.display_name,c.max_orders_per_trip,c.is_enabled,c.is_available,c.created_at,c.updated_at
        FROM logistica.couriers c
        WHERE (${page.available ?? null}::boolean IS NULL OR
          (c.is_enabled AND c.is_available AND NOT EXISTS (
            SELECT 1 FROM logistica.routes r WHERE r.courier_id=c.id AND r.status IN ('asignada','en_curso')
          ))=${page.available ?? null}::boolean)
        ORDER BY c.id LIMIT ${page.limit}::integer OFFSET ${page.offset}::integer`;
      return rows.map(mapCourier);
    } catch (error: unknown) { persistenceError(error); }
  }
  async setAvailability(id: string, available: boolean) {
    try {
      return await this.database.$transaction(async client => {
        await getCourier(client, id);
        // Wrap void-returning functions to avoid unsupported PostgreSQL void deserialization.
        await client.$queryRaw`SELECT 1 AS ok FROM logistica.set_courier_availability(${id}::uuid,${available}::boolean)`;
        return getCourier(client, id);
      });
    } catch (error: unknown) { persistenceError(error); }
  }
}

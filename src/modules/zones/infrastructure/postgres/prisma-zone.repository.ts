import { Zone, type NewZone } from '../../domain/zone.entity.js';
import { ZoneConflictError, PersistenceUnavailableError } from '../../domain/zone.errors.js';
import type { ZoneRepository } from '../../application/ports/zone.repository.port.js';
import type { PrismaDatabaseClient, PrismaQueryClient } from '../../../../infrastructure/postgres/prisma-client.port.js';

export interface PrismaZoneRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export type PrismaClientLike = PrismaDatabaseClient;

function mapZone(record: PrismaZoneRecord): Zone {
  return Zone.create({id:record.id,name:record.name,createdAt:record.createdAt,updatedAt:record.updatedAt});
}

export class PrismaZoneRepository implements ZoneRepository {
  constructor(private readonly prisma: PrismaClientLike) {}

  async create(zone: NewZone): Promise<Zone> {
    try {
      return await this.prisma.$transaction(async (client) => {
        const ids = await client.$queryRaw<readonly {id:string}[]>`SELECT logistica.create_zone(${zone.name}::text) AS id`;
        if (ids.length !== 1 || !ids[0]) throw new PersistenceUnavailableError();
        const created = await this.getById(client, ids[0].id);
        if (!created) throw new PersistenceUnavailableError();
        return created;
      });
    } catch (error: unknown) { this.handleError(error); }
  }

  async findById(id: string): Promise<Zone | null> {
    try { return await this.getById(this.prisma, id); }
    catch (error: unknown) { this.handleError(error); }
  }

  async findByName(name: string): Promise<Zone | null> {
    try {
      const rows = await this.prisma.$queryRaw<readonly PrismaZoneRecord[]>`
        SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt"
        FROM logistica.zones WHERE lower(btrim(name))=lower(btrim(${name}::text)) LIMIT 1`;
      return rows[0] ? mapZone(rows[0]) : null;
    } catch (error: unknown) { this.handleError(error); }
  }

  async findAll(): Promise<readonly Zone[]> {
    try {
      const rows = await this.prisma.$queryRaw<readonly PrismaZoneRecord[]>`
        SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt" FROM logistica.zones ORDER BY name,id`;
      return rows.map(mapZone);
    } catch (error: unknown) { this.handleError(error); }
  }

  private async getById(client: PrismaQueryClient, id: string): Promise<Zone | null> {
    const rows = await client.$queryRaw<readonly PrismaZoneRecord[]>`
      SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt" FROM logistica.zones WHERE id=${id}::uuid`;
    return rows[0] ? mapZone(rows[0]) : null;
  }

  private handleError(error: unknown): never {
    if (error instanceof ZoneConflictError || error instanceof PersistenceUnavailableError) throw error;
    const detail = error as {code?:unknown;meta?:{code?:unknown;driverAdapterError?:{cause?:{originalCode?:unknown}}}} | null;
    const codes = new Set([detail?.code,detail?.meta?.code,detail?.meta?.driverAdapterError?.cause?.originalCode]);
    if (codes.has('P2002') || codes.has('23505')) throw new ZoneConflictError();
    throw new PersistenceUnavailableError();
  }
}

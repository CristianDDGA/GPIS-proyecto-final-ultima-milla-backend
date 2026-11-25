import { Zone, type NewZone, type ZoneCoverage } from '../../domain/zone.entity.js';
import { ZoneConflictError, ZoneInUseError, PersistenceUnavailableError } from '../../domain/zone.errors.js';
import type { ZoneRepository } from '../../application/ports/zone.repository.port.js';
import type { PrismaDatabaseClient, PrismaQueryClient } from '../../../../infrastructure/postgres/prisma-client.port.js';

export interface PrismaZoneRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly centerLatitude?: number | null;
  readonly centerLongitude?: number | null;
  readonly coverageRadiusKm?: number | string | null;
  readonly isActive?: boolean;
}
export type PrismaClientLike = PrismaDatabaseClient;

function mapCoverage(record: PrismaZoneRecord): ZoneCoverage | null {
  if (record.centerLatitude == null || record.centerLongitude == null || record.coverageRadiusKm == null) return null;
  return { latitude: Number(record.centerLatitude), longitude: Number(record.centerLongitude), radiusKm: Number(record.coverageRadiusKm) };
}

function mapZone(record: PrismaZoneRecord): Zone {
  return Zone.create({id:record.id,name:record.name,createdAt:record.createdAt,updatedAt:record.updatedAt,coverage:mapCoverage(record),isActive:record.isActive !== false});
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
        SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt",center_latitude AS "centerLatitude",center_longitude AS "centerLongitude",coverage_radius_km::text AS "coverageRadiusKm",is_active AS "isActive"
        FROM logistica.zones WHERE lower(btrim(name))=lower(btrim(${name}::text)) LIMIT 1`;
      return rows[0] ? mapZone(rows[0]) : null;
    } catch (error: unknown) { this.handleError(error); }
  }

  async findAll(): Promise<readonly Zone[]> {
    try {
      const rows = await this.prisma.$queryRaw<readonly PrismaZoneRecord[]>`
        SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt",center_latitude AS "centerLatitude",center_longitude AS "centerLongitude",coverage_radius_km::text AS "coverageRadiusKm",is_active AS "isActive" FROM logistica.zones ORDER BY name,id`;
      return rows.map(mapZone);
    } catch (error: unknown) { this.handleError(error); }
  }

  async setCoverage(id: string, coverage: ZoneCoverage | null): Promise<Zone | null> {
    try {
      return await this.prisma.$transaction(async (client) => {
        const rows = await client.$queryRaw<readonly {updated:boolean}[]>`
          SELECT logistica.set_zone_coverage(${id}::uuid, ${coverage?.latitude ?? null}::double precision,
            ${coverage?.longitude ?? null}::double precision, ${coverage?.radiusKm ?? null}::numeric) AS updated`;
        if (rows[0]?.updated !== true) return null;
        return this.getById(client, id);
      });
    } catch (error: unknown) { this.handleError(error); }
  }

  async setActive(id: string, active: boolean): Promise<Zone | null> {
    try {
      return await this.prisma.$transaction(async (client) => {
        const rows = await client.$queryRaw<readonly {updated:boolean}[]>`SELECT logistica.set_zone_active(${id}::uuid, ${active}::boolean) AS updated`;
        if (rows[0]?.updated !== true) return null;
        return this.getById(client, id);
      });
    } catch (error: unknown) { this.handleError(error); }
  }

  async findCovering(latitude: number, longitude: number): Promise<Zone | null> {
    try {
      const rows = await this.prisma.$queryRaw<readonly {id:string|null}[]>`
        SELECT logistica.zone_for_point(${latitude}::double precision, ${longitude}::double precision) AS id`;
      const id = rows[0]?.id ?? null;
      return id === null ? null : await this.getById(this.prisma, id);
    } catch (error: unknown) { this.handleError(error); }
  }

  private async getById(client: PrismaQueryClient, id: string): Promise<Zone | null> {
    const rows = await client.$queryRaw<readonly PrismaZoneRecord[]>`
      SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt",center_latitude AS "centerLatitude",center_longitude AS "centerLongitude",coverage_radius_km::text AS "coverageRadiusKm",is_active AS "isActive" FROM logistica.zones WHERE id=${id}::uuid`;
    return rows[0] ? mapZone(rows[0]) : null;
  }

  private handleError(error: unknown): never {
    if (error instanceof ZoneConflictError || error instanceof ZoneInUseError || error instanceof PersistenceUnavailableError) throw error;
    const texts = [(error as {message?: unknown} | null)?.message, (error as {meta?: {message?: unknown}} | null)?.meta?.message];
    if (texts.some((text) => typeof text === 'string' && text.includes('ZONE_HAS_OPEN_WORK'))) throw new ZoneInUseError();
    const detail = error as {code?:unknown;meta?:{code?:unknown;driverAdapterError?:{cause?:{originalCode?:unknown}}}} | null;
    const codes = new Set([detail?.code,detail?.meta?.code,detail?.meta?.driverAdapterError?.cause?.originalCode]);
    if (codes.has('P2002') || codes.has('23505')) throw new ZoneConflictError();
    throw new PersistenceUnavailableError();
  }
}

import type { Zone, NewZone, ZoneCoverage } from '../../domain/zone.entity.js';

export interface ZoneRepository {
  create(zone: NewZone): Promise<Zone>;
  findById(id: string): Promise<Zone | null>;
  findByName(name: string): Promise<Zone | null>;
  findAll(): Promise<readonly Zone[]>;
  /** Fija (o quita con null) la cobertura. null si la zona no existe. */
  setCoverage(id: string, coverage: ZoneCoverage | null): Promise<Zone | null>;
  /** Zona activa cuyo radio incluye el punto (la de centro más cercano); null si ninguna lo cubre. */
  findCovering(latitude: number, longitude: number): Promise<Zone | null>;
}

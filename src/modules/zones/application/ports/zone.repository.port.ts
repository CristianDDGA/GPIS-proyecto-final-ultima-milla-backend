import type { Zone, NewZone } from '../../domain/zone.entity.js';

export interface ZoneRepository {
  create(zone: NewZone): Promise<Zone>;
  findById(id: string): Promise<Zone | null>;
  findByName(name: string): Promise<Zone | null>;
  findAll(): Promise<readonly Zone[]>;
}

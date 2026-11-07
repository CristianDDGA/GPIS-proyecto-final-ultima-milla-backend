import { randomUUID } from 'node:crypto';
import { Zone, type NewZone } from '../../domain/zone.entity.js';
import { ZoneConflictError } from '../../domain/zone.errors.js';
import type { ZoneRepository } from '../../application/ports/zone.repository.port.js';

export class InMemoryZoneRepository implements ZoneRepository {
  private readonly zones = new Map<string, Zone>();

  async create(input: NewZone): Promise<Zone> {
    const prepared = Zone.prepare(input);
    const now = new Date();
    const zone = Zone.create({ ...prepared, id: randomUUID(), createdAt: now, updatedAt: now });
    for (const existing of this.zones.values()) {
      if (existing.name.toLowerCase() === zone.name.toLowerCase()) {
        throw new ZoneConflictError(`Ya existe una zona registrada con el nombre '${zone.name}'.`);
      }
    }

    this.zones.set(zone.id, zone);
    return zone;
  }

  async findById(id: string): Promise<Zone | null> {
    return this.zones.get(id) ?? null;
  }

  async findByName(name: string): Promise<Zone | null> {
    const target = name.toLowerCase();
    for (const zone of this.zones.values()) {
      if (zone.name.toLowerCase() === target) {
        return zone;
      }
    }
    return null;
  }

  async findAll(): Promise<readonly Zone[]> {
    return Array.from(this.zones.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  clear(): void {
    this.zones.clear();
  }
}

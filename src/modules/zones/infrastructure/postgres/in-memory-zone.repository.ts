import { randomUUID } from 'node:crypto';
import { Zone, distanceKm, type NewZone, type ZoneCoverage } from '../../domain/zone.entity.js';
import { ZoneConflictError, ZoneInUseError } from '../../domain/zone.errors.js';
import type { ZoneRepository } from '../../application/ports/zone.repository.port.js';

export class InMemoryZoneRepository implements ZoneRepository {
  private readonly zones = new Map<string, Zone>();

  /** `hasOpenWork`: en memoria las rutas y pedidos son de otros módulos; la prueba o la composición inyecta esta consulta. */
  constructor(private readonly hasOpenWork: (zoneId: string) => Promise<boolean> = async () => false) {}

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

  async setCoverage(id: string, coverage: ZoneCoverage | null): Promise<Zone | null> {
    const zone = this.zones.get(id);
    if (!zone) return null;
    const updated = Zone.create({ id: zone.id, name: zone.name, createdAt: zone.createdAt, updatedAt: new Date(), coverage, isActive: zone.isActive });
    this.zones.set(id, updated);
    return updated;
  }

  async setActive(id: string, active: boolean): Promise<Zone | null> {
    const zone = this.zones.get(id);
    if (!zone) return null;
    if (zone.isActive === active) return zone;
    if (!active && (await this.hasOpenWork(id))) throw new ZoneInUseError();
    const updated = Zone.create({ id: zone.id, name: zone.name, createdAt: zone.createdAt, updatedAt: new Date(), coverage: zone.coverage, isActive: active });
    this.zones.set(id, updated);
    return updated;
  }

  async findCovering(latitude: number, longitude: number): Promise<Zone | null> {
    let best: { zone: Zone; distance: number } | null = null;
    for (const zone of this.zones.values()) {
      const coverage = zone.coverage;
      if (!zone.isActive || coverage === null || !zone.covers(latitude, longitude)) continue;
      const distance = distanceKm(coverage.latitude, coverage.longitude, latitude, longitude);
      if (best === null || distance < best.distance || (distance === best.distance && zone.id < best.zone.id)) best = { zone, distance };
    }
    return best?.zone ?? null;
  }

  clear(): void {
    this.zones.clear();
  }
}

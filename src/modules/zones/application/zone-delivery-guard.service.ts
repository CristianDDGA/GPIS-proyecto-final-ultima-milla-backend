import type { DeliveryPoint, DeliveryZoneIssue, ZoneDeliveryGuard } from '../../../shared/zone-delivery-guard.port.js';
import type { ZoneRepository } from './ports/zone.repository.port.js';

/** Aplica la regla de entrega con el repositorio de zonas: sirve igual en memoria y en PostgreSQL. */
export class ZoneDeliveryGuardService implements ZoneDeliveryGuard {
  constructor(private readonly zones: Pick<ZoneRepository, 'findById'>) {}

  async check(zoneId: string, point: DeliveryPoint): Promise<DeliveryZoneIssue | null> {
    const zone = await this.zones.findById(zoneId);
    if (zone === null) return null;
    if (zone.coverage === null) return 'ZONE_NOT_OPERATIONAL';
    if (point.latitude === null || point.longitude === null) return 'PIN_REQUIRED';
    return zone.covers(point.latitude, point.longitude) ? null : 'ZONE_OUT_OF_COVERAGE';
  }
}

import { validateCoverage, validatePoint, type Zone } from '../../domain/zone.entity.js';
import { ZoneNotFoundError, ZoneValidationError } from '../../domain/zone.errors.js';
import type { ZoneRepository } from '../ports/zone.repository.port.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** El administrador fija el centro y el radio que atiende una zona (o los quita con null). */
export class SetZoneCoverageUseCase {
  constructor(private readonly zoneRepository: ZoneRepository) {}

  async execute(id: string, coverage: unknown): Promise<Zone> {
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      throw new ZoneValidationError('El identificador de la zona debe ser un UUID válido.');
    }
    const valid = validateCoverage(coverage);
    const zone = await this.zoneRepository.setCoverage(id, valid);
    if (zone === null) throw new ZoneNotFoundError(`No se encontró la zona con identificador '${id}'.`);
    return zone;
  }
}

/** Qué zona atiende un punto del mapa; null si el punto está fuera de toda cobertura. */
export class FindZoneForPointUseCase {
  constructor(private readonly zoneRepository: ZoneRepository) {}

  async execute(latitude: unknown, longitude: unknown): Promise<Zone | null> {
    const point = validatePoint(latitude, longitude);
    return this.zoneRepository.findCovering(point.latitude, point.longitude);
  }
}

import type { Zone } from '../../domain/zone.entity.js';
import { ZoneNotFoundError, ZoneValidationError } from '../../domain/zone.errors.js';
import type { ZoneRepository } from '../ports/zone.repository.port.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** El administrador activa o desactiva una zona. Desactivar exige que no tenga rutas ni pedidos abiertos. */
export class SetZoneActiveUseCase {
  constructor(private readonly zoneRepository: ZoneRepository) {}

  async execute(id: string, active: unknown): Promise<Zone> {
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      throw new ZoneValidationError('El identificador de la zona debe ser un UUID válido.');
    }
    if (typeof active !== 'boolean') {
      throw new ZoneValidationError('isActive debe ser verdadero o falso.');
    }
    const zone = await this.zoneRepository.setActive(id, active);
    if (zone === null) throw new ZoneNotFoundError(`No se encontró la zona con identificador '${id}'.`);
    return zone;
  }
}

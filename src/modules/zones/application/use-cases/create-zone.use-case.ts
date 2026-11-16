import { Zone } from '../../domain/zone.entity.js';
import { ZoneConflictError, ZoneValidationError } from '../../domain/zone.errors.js';
import { validatePlaceName } from '../../../../shared/text-validation.js';
import type { ZoneRepository } from '../ports/zone.repository.port.js';

export interface CreateZoneCommand {
  readonly name: string;
}

export class CreateZoneUseCase {
  constructor(private readonly zoneRepository: ZoneRepository) {}

  async execute(command: CreateZoneCommand): Promise<Zone> {
    // Regla estricta solo al crear: la rehidratación de zonas existentes no se bloquea.
    const checked = validatePlaceName(command.name, 'El nombre de la zona');
    if (!checked.ok) throw new ZoneValidationError(checked.reason);
    const zone = Zone.prepare({ name: checked.value });

    const existingZone = await this.zoneRepository.findByName(zone.name);
    if (existingZone !== null) {
      throw new ZoneConflictError(`Ya existe una zona registrada con el nombre '${zone.name}'.`);
    }

    return await this.zoneRepository.create(zone);
  }
}

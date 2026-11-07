import { Zone } from '../../domain/zone.entity.js';
import { ZoneConflictError } from '../../domain/zone.errors.js';
import type { ZoneRepository } from '../ports/zone.repository.port.js';

export interface CreateZoneCommand {
  readonly name: string;
}

export class CreateZoneUseCase {
  constructor(private readonly zoneRepository: ZoneRepository) {}

  async execute(command: CreateZoneCommand): Promise<Zone> {
    const zone = Zone.prepare({ name: command.name });

    const existingZone = await this.zoneRepository.findByName(zone.name);
    if (existingZone !== null) {
      throw new ZoneConflictError(`Ya existe una zona registrada con el nombre '${zone.name}'.`);
    }

    return await this.zoneRepository.create(zone);
  }
}

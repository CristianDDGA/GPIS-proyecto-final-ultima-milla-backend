import { ZoneValidationError } from './zone.errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NewZone { readonly name: string; }
export interface ZoneProperties extends NewZone {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface ZoneDto {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class Zone {
  private constructor(private readonly properties: ZoneProperties) {}

  get id(): string { return this.properties.id; }
  get name(): string { return this.properties.name; }
  get createdAt(): Date { return new Date(this.properties.createdAt); }
  get updatedAt(): Date { return new Date(this.properties.updatedAt); }

  static prepare(properties: NewZone): NewZone {
    if (typeof properties.name !== 'string' || properties.name.trim().length === 0) {
      throw new ZoneValidationError('El nombre de la zona debe ser un texto no vacío.');
    }
    return { name: properties.name.trim() };
  }

  // Rehydration requires persisted metadata; the domain never generates IDs or reads the clock.
  static create(properties: ZoneProperties): Zone {
    const { name } = Zone.prepare(properties);
    if (typeof properties.id !== 'string' || !UUID_REGEX.test(properties.id)) {
      throw new ZoneValidationError('El identificador de la zona debe ser un UUID válido.');
    }
    if (!(properties.createdAt instanceof Date) || !Number.isFinite(properties.createdAt.getTime()) ||
        !(properties.updatedAt instanceof Date) || !Number.isFinite(properties.updatedAt.getTime()) ||
        properties.updatedAt.getTime() < properties.createdAt.getTime()) {
      throw new ZoneValidationError('Los metadatos de fecha de la zona son inválidos.');
    }
    return new Zone({ id: properties.id, name, createdAt: new Date(properties.createdAt), updatedAt: new Date(properties.updatedAt) });
  }

  toJSON(): ZoneDto {
    return { id: this.id, name: this.name, createdAt: this.createdAt.toISOString(), updatedAt: this.updatedAt.toISOString() };
  }
}

import { isWithinEcuador } from '../../../shared/geo.js';
import { ZoneValidationError } from './zone.errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NewZone { readonly name: string; }
/** Área que atiende la zona: un centro dentro de Ecuador y un radio en km (0,1 a 50). */
export interface ZoneCoverage {
  readonly latitude: number;
  readonly longitude: number;
  readonly radiusKm: number;
}
export interface ZoneProperties extends NewZone {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly coverage?: ZoneCoverage | null;
  /** false: la zona no recibe pedidos ni entra en la planificación. Por defecto true. */
  readonly isActive?: boolean;
}
export interface ZoneDto {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly coverage: ZoneCoverage | null;
  readonly isActive: boolean;
}

export const MIN_COVERAGE_RADIUS_KM = 0.1;
export const MAX_COVERAGE_RADIUS_KM = 50;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export { isWithinEcuador };

/** Valida un punto del mapa; lanza ZoneValidationError si no es un par de números dentro de Ecuador. */
export function validatePoint(latitude: unknown, longitude: unknown): { latitude: number; longitude: number } {
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) {
    throw new ZoneValidationError('La latitud y la longitud deben ser números.');
  }
  if (!isWithinEcuador(latitude, longitude)) {
    throw new ZoneValidationError('El punto debe estar dentro de Ecuador.');
  }
  return { latitude, longitude };
}

/** Valida la cobertura que envía el administrador; null la quita. */
export function validateCoverage(value: unknown): ZoneCoverage | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ZoneValidationError('La cobertura debe ser un objeto con latitude, longitude y radiusKm, o null.');
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !['latitude', 'longitude', 'radiusKm'].includes(key));
  if (unknownKeys.length > 0) throw new ZoneValidationError(`Campo no permitido en la cobertura: ${unknownKeys[0]}.`);
  const point = validatePoint(record['latitude'], record['longitude']);
  const radius = record['radiusKm'];
  if (!isFiniteNumber(radius) || radius < MIN_COVERAGE_RADIUS_KM || radius > MAX_COVERAGE_RADIUS_KM) {
    throw new ZoneValidationError(`El radio debe ser un número entre ${MIN_COVERAGE_RADIUS_KM} y ${MAX_COVERAGE_RADIUS_KM} km.`);
  }
  return { ...point, radiusKm: Math.round(radius * 100) / 100 };
}

/** Distancia de gran círculo en km (haversine), la misma fórmula que distance_km (015). */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

export class Zone {
  private constructor(private readonly properties: ZoneProperties) {}

  get id(): string { return this.properties.id; }
  get name(): string { return this.properties.name; }
  get createdAt(): Date { return new Date(this.properties.createdAt); }
  get updatedAt(): Date { return new Date(this.properties.updatedAt); }
  get coverage(): ZoneCoverage | null { return this.properties.coverage ?? null; }
  get isActive(): boolean { return this.properties.isActive !== false; }

  /** true si el punto cae dentro del radio de la zona. */
  covers(latitude: number, longitude: number): boolean {
    const coverage = this.coverage;
    return coverage !== null && distanceKm(coverage.latitude, coverage.longitude, latitude, longitude) <= coverage.radiusKm;
  }

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
    const coverage = properties.coverage ?? null;
    return new Zone({
      id: properties.id, name, createdAt: new Date(properties.createdAt), updatedAt: new Date(properties.updatedAt),
      coverage: coverage === null ? null : { ...coverage },
      isActive: properties.isActive !== false,
    });
  }

  toJSON(): ZoneDto {
    return {
      id: this.id, name: this.name, createdAt: this.createdAt.toISOString(), updatedAt: this.updatedAt.toISOString(),
      coverage: this.coverage === null ? null : { ...this.coverage },
      isActive: this.isActive,
    };
  }
}

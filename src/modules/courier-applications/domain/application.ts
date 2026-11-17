import { normalizeText, validatePersonName } from '../../../shared/text-validation.js';
import { ApplicationError } from './application.errors.js';

export type ApplicationStatus = 'borrador' | 'pendiente' | 'aprobada' | 'rechazada' | 'cancelada';
export const APPLICATION_STATUSES: readonly ApplicationStatus[] = ['borrador', 'pendiente', 'aprobada', 'rechazada', 'cancelada'];
export type FileKind = 'license' | 'photo';
export const FILE_KINDS: readonly FileKind[] = ['license', 'photo'];
export type ImageType = 'image/jpeg' | 'image/png';
export type VehicleType = 'moto' | 'auto' | 'camioneta';
export const VEHICLE_TYPES: readonly VehicleType[] = ['moto', 'auto', 'camioneta'];
export const LICENSE_CATEGORIES = ['A', 'A1', 'B', 'C', 'C1', 'D', 'D1', 'E', 'E1', 'F', 'G'] as const;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MIN_AGE_YEARS = 18;

export interface ApplicationData {
  readonly fullName: string;
  readonly nationalId: string;
  readonly phone: string;
  /** YYYY-MM-DD */
  readonly birthDate: string;
  readonly vehicleType: VehicleType;
  readonly licenseNumber: string;
  readonly licenseCategory: string;
  /** YYYY-MM-DD */
  readonly licenseExpiresOn: string;
}

export interface ApplicationFileInfo {
  readonly kind: FileKind;
  readonly contentType: ImageType;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
}

export interface CourierApplication extends ApplicationData {
  readonly id: string;
  readonly userId: string;
  readonly status: ApplicationStatus;
  readonly files: readonly ApplicationFileInfo[];
  readonly submittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly rejectionReason: string | null;
  readonly approvedCapacity: number | null;
  readonly createdAt: string;
}

/** Vista del administrador: la solicitud con los datos de la cuenta del solicitante. */
export interface ApplicationDetail extends CourierApplication {
  readonly applicantEmail: string;
  readonly applicantName: string | null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Fecha de hoy en Ecuador (YYYY-MM-DD). */
export function todayInEcuador(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function subtractYears(isoDate: string, years: number): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year - years, month - 1, day));
  // 29 de febrero -> 28 de febrero si el año destino no es bisiesto.
  if (target.getUTCMonth() !== month - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

function fail(message: string): never {
  throw new ApplicationError('VALIDATION_ERROR', message);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} es obligatorio y debe ser texto.`);
  return value;
}

/** Valida los datos del formulario. `today` permite fijar la fecha en las pruebas. */
export function validateApplicationData(input: Record<string, unknown>, today: string = todayInEcuador()): ApplicationData {
  const name = validatePersonName(input['fullName'], 'El nombre completo');
  if (!name.ok) fail(name.reason);
  if (name.value.split(' ').length < 2) fail('Indica tus nombres y apellidos.');

  const nationalId = text(input['nationalId'], 'La cédula').trim();
  if (!/^\d{10}$/.test(nationalId)) fail('La cédula debe tener 10 dígitos.');

  const phone = text(input['phone'], 'El teléfono').replace(/[\s-]/g, '');
  if (!/^\+?\d{7,15}$/.test(phone)) fail('El teléfono debe tener entre 7 y 15 dígitos (puede iniciar con +).');

  const birthDate = text(input['birthDate'], 'La fecha de nacimiento').trim();
  if (!isValidIsoDate(birthDate)) fail('La fecha de nacimiento debe tener el formato AAAA-MM-DD y existir en el calendario.');
  if (birthDate > subtractYears(today, MIN_AGE_YEARS)) fail('Debes ser mayor de 18 años.');
  if (birthDate < subtractYears(today, 100)) fail('La fecha de nacimiento no es válida.');

  const vehicleType = text(input['vehicleType'], 'El tipo de vehículo');
  if (!VEHICLE_TYPES.includes(vehicleType as VehicleType)) fail(`El tipo de vehículo debe ser uno de: ${VEHICLE_TYPES.join(', ')}.`);

  const licenseNumber = normalizeText(text(input['licenseNumber'], 'El número de licencia')).toUpperCase();
  if (!/^[A-Z0-9-]{4,20}$/.test(licenseNumber)) fail('El número de licencia solo admite letras, números y guion (4 a 20 caracteres).');

  const licenseCategory = text(input['licenseCategory'], 'La categoría de la licencia').trim().toUpperCase();
  if (!(LICENSE_CATEGORIES as readonly string[]).includes(licenseCategory)) {
    fail(`La categoría de la licencia debe ser una de: ${LICENSE_CATEGORIES.join(', ')}.`);
  }

  const licenseExpiresOn = text(input['licenseExpiresOn'], 'La fecha de caducidad de la licencia').trim();
  if (!isValidIsoDate(licenseExpiresOn)) fail('La fecha de caducidad debe tener el formato AAAA-MM-DD y existir en el calendario.');
  if (licenseExpiresOn <= today) fail('La licencia está caducada.');

  return {
    fullName: name.value,
    nationalId,
    phone,
    birthDate,
    vehicleType: vehicleType as VehicleType,
    licenseNumber,
    licenseCategory,
    licenseExpiresOn,
  };
}

/** Reconoce JPEG o PNG por su firma (no confía en la extensión ni en la cabecera del cliente). */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((value, index) => bytes[index] === value)) return 'image/png';
  return null;
}

export function validateFileKind(value: unknown): FileKind {
  if (typeof value !== 'string' || !FILE_KINDS.includes(value as FileKind)) {
    throw new ApplicationError('VALIDATION_ERROR', `El tipo de archivo debe ser uno de: ${FILE_KINDS.join(', ')}.`);
  }
  return value as FileKind;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateApplicationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ApplicationError('VALIDATION_ERROR', 'El identificador de la solicitud no es válido.');
  }
  return value.toLowerCase();
}

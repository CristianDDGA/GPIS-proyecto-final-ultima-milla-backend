import { createHash, randomBytes } from 'node:crypto';
import { normalizeText } from '../../../shared/text-validation.js';
import type { EmailSender } from '../../auth/application/ports/email-sender.port.js';
import { maskEmail, type SecurityLog } from '../../auth/application/ports/security-log.port.js';
import type { TokenRevocationStore } from '../../auth/application/ports/token-revocation.port.js';
import type { AppRole } from '../../auth/domain/auth-user.entity.js';
import {
  APPLICATION_STATUSES,
  MAX_IMAGE_BYTES,
  detectImageType,
  validateApplicationData,
  validateApplicationId,
  validateFileKind,
  type ApplicationDetail,
  type ApplicationStatus,
  type CourierApplication,
  type ImageType,
} from '../domain/application.js';
import { ApplicationError } from '../domain/application.errors.js';
import { buildDecisionEmail } from './application-emails.js';
import type { ApplicationRepository } from './ports/application.repository.port.js';
import type { FileStorage } from './ports/file-storage.port.js';

export interface ApplicationActor {
  readonly id: string;
  readonly role: AppRole;
}

export interface ApplicationListQuery {
  readonly status?: unknown;
  readonly q?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface FileContent {
  readonly bytes: Uint8Array;
  readonly contentType: ImageType;
}

export interface ApplicationUseCases {
  // Cliente (dueño de la solicitud)
  saveDraft(actor: ApplicationActor, input: Record<string, unknown>): Promise<CourierApplication>;
  uploadFile(actor: ApplicationActor, kind: unknown, bytes: Uint8Array): Promise<CourierApplication>;
  submit(actor: ApplicationActor): Promise<CourierApplication>;
  cancel(actor: ApplicationActor): Promise<CourierApplication>;
  getMine(actor: ApplicationActor): Promise<CourierApplication | null>;
  readMyFile(actor: ApplicationActor, kind: unknown): Promise<FileContent>;
  // Administrador
  list(actor: ApplicationActor, query: ApplicationListQuery): Promise<{ items: readonly ApplicationDetail[]; total: number; limit: number; offset: number }>;
  get(actor: ApplicationActor, id: unknown): Promise<ApplicationDetail>;
  readFile(actor: ApplicationActor, id: unknown, kind: unknown): Promise<FileContent>;
  approve(actor: ApplicationActor, id: unknown, input: Record<string, unknown>): Promise<ApplicationDetail>;
  reject(actor: ApplicationActor, id: unknown, input: Record<string, unknown>): Promise<ApplicationDetail>;
}

export interface ApplicationUseCaseOptions {
  readonly emailSender?: EmailSender;
  readonly securityLog?: SecurityLog;
  /** Capacidad (pedidos por viaje) con la que nace el conductor si el administrador no indica otra. */
  readonly defaultCapacity?: number;
  /** Fecha de hoy (YYYY-MM-DD) fija; solo para pruebas. */
  readonly today?: () => string;
}

const DEFAULT_CAPACITY = 10;
const MAX_CAPACITY = 200;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

function requireRole(actor: ApplicationActor, role: AppRole, message: string): void {
  if (actor.role !== role) throw new ApplicationError('FORBIDDEN', message);
}

function parseBoundedInteger(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} debe ser un entero entre ${min} y ${max}.`);
  }
  return parsed;
}

export function createApplicationUseCases(
  repository: ApplicationRepository,
  storage: FileStorage,
  revocationStore: TokenRevocationStore,
  options: ApplicationUseCaseOptions = {},
): ApplicationUseCases {
  const defaultCapacity = options.defaultCapacity ?? DEFAULT_CAPACITY;

  function audit(event: Parameters<SecurityLog>[0]): void {
    try {
      options.securityLog?.(event);
    } catch {
      // El registro de eventos nunca debe romper la petición.
    }
  }

  async function latestOrThrow(userId: string): Promise<CourierApplication> {
    const latest = await repository.findLatestByUser(userId);
    if (!latest) throw new ApplicationError('NO_OPEN_APPLICATION');
    return latest;
  }

  async function notifyDecision(detail: ApplicationDetail, approved: boolean, reason?: string): Promise<void> {
    if (!options.emailSender) return;
    try {
      await options.emailSender.send(
        buildDecisionEmail({ to: detail.applicantEmail, name: detail.applicantName, approved, ...(reason ? { reason } : {}) }),
      );
    } catch {
      // Si el correo falla, la decisión ya quedó guardada; el solicitante la ve al consultar su solicitud.
    }
  }

  async function readStored(bytesKey: { storageKey: string; contentType: ImageType } | null): Promise<FileContent> {
    if (!bytesKey) throw new ApplicationError('FILE_NOT_FOUND');
    const bytes = await storage.read(bytesKey.storageKey);
    if (!bytes) throw new ApplicationError('FILE_NOT_FOUND');
    return { bytes, contentType: bytesKey.contentType };
  }

  async function reviewable(id: string): Promise<ApplicationDetail> {
    const detail = await repository.findDetail(id);
    if (!detail) throw new ApplicationError('APPLICATION_NOT_FOUND');
    return detail;
  }

  function mapReview(result: Awaited<ReturnType<ApplicationRepository['review']>>): void {
    if (result === 'OK') return;
    if (result === 'NOT_FOUND') throw new ApplicationError('APPLICATION_NOT_FOUND');
    if (result === 'NOT_PENDING') throw new ApplicationError('NOT_PENDING');
    if (result === 'NOT_CLIENT') throw new ApplicationError('APPLICANT_NOT_CLIENT');
    throw new ApplicationError('FORBIDDEN');
  }

  return {
    async saveDraft(actor, input) {
      requireRole(actor, 'cliente', 'Solo un cliente puede solicitar ser conductor.');
      const data = validateApplicationData(input, options.today?.());
      const result = await repository.saveDraft(actor.id, data);
      if (result === 'NOT_CLIENT') throw new ApplicationError('FORBIDDEN', 'Solo un cliente activo puede solicitar ser conductor.');
      if (result === 'EMAIL_NOT_VERIFIED') throw new ApplicationError('EMAIL_NOT_VERIFIED');
      if (result === 'ALREADY_PENDING') throw new ApplicationError('ALREADY_PENDING');
      if (result === 'DUPLICATE_NATIONAL_ID') throw new ApplicationError('DUPLICATE_NATIONAL_ID');
      return latestOrThrow(actor.id);
    },

    async uploadFile(actor, kindInput, bytes) {
      requireRole(actor, 'cliente', 'Solo un cliente puede solicitar ser conductor.');
      const kind = validateFileKind(kindInput);
      if (bytes.length === 0) throw new ApplicationError('VALIDATION_ERROR', 'La imagen está vacía.');
      if (bytes.length > MAX_IMAGE_BYTES) throw new ApplicationError('FILE_TOO_LARGE');
      const contentType = detectImageType(bytes);
      if (!contentType) throw new ApplicationError('UNSUPPORTED_MEDIA_TYPE');
      const latest = await repository.findLatestByUser(actor.id);
      if (latest?.status !== 'borrador') throw new ApplicationError('NO_OPEN_APPLICATION');
      const previous = await repository.findFileByUser(actor.id, kind);
      const storageKey = `${randomBytes(16).toString('hex')}${contentType === 'image/png' ? '.png' : '.jpg'}`;
      await storage.save(storageKey, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      let attached: Awaited<ReturnType<ApplicationRepository['attachFile']>>;
      try {
        attached = await repository.attachFile(actor.id, { kind, contentType, sizeBytes: bytes.length, sha256, storageKey });
      } catch (error: unknown) {
        await storage.delete(storageKey);
        throw error;
      }
      if (attached === 'NO_DRAFT') {
        await storage.delete(storageKey);
        throw new ApplicationError('NO_OPEN_APPLICATION');
      }
      if (previous) await storage.delete(previous.storageKey).catch(() => undefined);
      return latestOrThrow(actor.id);
    },

    async submit(actor) {
      requireRole(actor, 'cliente', 'Solo un cliente puede solicitar ser conductor.');
      const result = await repository.submit(actor.id);
      if (result === 'NO_DRAFT') throw new ApplicationError('NO_OPEN_APPLICATION');
      if (result === 'MISSING_FILES') throw new ApplicationError('MISSING_FILES');
      if (result === 'LICENSE_EXPIRED') throw new ApplicationError('VALIDATION_ERROR', 'La licencia está caducada.');
      if (result === 'UNDERAGE') throw new ApplicationError('VALIDATION_ERROR', 'Debes ser mayor de 18 años.');
      if (result === 'DUPLICATE_NATIONAL_ID') throw new ApplicationError('DUPLICATE_NATIONAL_ID');
      audit({ type: 'courier_application_submitted', userId: actor.id });
      return latestOrThrow(actor.id);
    },

    async cancel(actor) {
      requireRole(actor, 'cliente', 'Solo un cliente puede solicitar ser conductor.');
      const result = await repository.cancel(actor.id);
      if (result === 'NOT_FOUND') throw new ApplicationError('NO_OPEN_APPLICATION');
      audit({ type: 'courier_application_cancelled', userId: actor.id });
      return latestOrThrow(actor.id);
    },

    async getMine(actor) {
      requireRole(actor, 'cliente', 'Solo un cliente puede solicitar ser conductor.');
      return repository.findLatestByUser(actor.id);
    },

    async readMyFile(actor, kindInput) {
      requireRole(actor, 'cliente', 'Solo un cliente puede solicitar ser conductor.');
      return readStored(await repository.findFileByUser(actor.id, validateFileKind(kindInput)));
    },

    async list(actor, query) {
      requireRole(actor, 'personal', 'Solo un administrador puede revisar solicitudes.');
      let status: ApplicationStatus | undefined;
      if (query.status !== undefined) {
        if (typeof query.status !== 'string' || query.status === 'borrador' || !APPLICATION_STATUSES.includes(query.status as ApplicationStatus)) {
          throw new ApplicationError('VALIDATION_ERROR', 'status debe ser pendiente, aprobada, rechazada o cancelada.');
        }
        status = query.status as ApplicationStatus;
      }
      let q: string | undefined;
      if (query.q !== undefined) {
        if (typeof query.q !== 'string') throw new ApplicationError('VALIDATION_ERROR', 'q debe ser texto.');
        const normalized = normalizeText(query.q);
        if (normalized.length > MAX_SEARCH_LENGTH) throw new ApplicationError('VALIDATION_ERROR', `q no puede superar ${MAX_SEARCH_LENGTH} caracteres.`);
        if (normalized.length > 0) q = normalized;
      }
      const limit = parseBoundedInteger(query.limit, 'limit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
      const offset = parseBoundedInteger(query.offset, 'offset', 0, 0, 1_000_000);
      const page = await repository.list({ ...(status ? { status } : {}), ...(q ? { q } : {}), limit, offset });
      return { items: page.items, total: page.total, limit, offset };
    },

    async get(actor, id) {
      requireRole(actor, 'personal', 'Solo un administrador puede revisar solicitudes.');
      return reviewable(validateApplicationId(id));
    },

    async readFile(actor, id, kindInput) {
      requireRole(actor, 'personal', 'Solo un administrador puede revisar solicitudes.');
      const applicationId = validateApplicationId(id);
      const kind = validateFileKind(kindInput);
      await reviewable(applicationId);
      return readStored(await repository.findFileByApplication(applicationId, kind));
    },

    async approve(actor, id, input) {
      requireRole(actor, 'personal', 'Solo un administrador puede aprobar solicitudes.');
      const applicationId = validateApplicationId(id);
      const capacity = input['capacity'] === undefined ? defaultCapacity : input['capacity'];
      if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
        throw new ApplicationError('VALIDATION_ERROR', `capacity debe ser un entero entre 1 y ${MAX_CAPACITY}.`);
      }
      mapReview(await repository.review(applicationId, actor.id, { approve: true, capacity }));
      const detail = await reviewable(applicationId);
      // La base ya fijó tokens_valid_after; aquí se refresca la caché local de esta instancia.
      await revocationStore.revokeUserSessions(detail.userId, Math.floor(Date.now() / 1000));
      audit({ type: 'courier_application_approved', email: maskEmail(detail.applicantEmail), userId: detail.userId, actorId: actor.id });
      await notifyDecision(detail, true);
      return detail;
    },

    async reject(actor, id, input) {
      requireRole(actor, 'personal', 'Solo un administrador puede rechazar solicitudes.');
      const applicationId = validateApplicationId(id);
      if (typeof input['reason'] !== 'string') throw new ApplicationError('VALIDATION_ERROR', 'El motivo del rechazo es obligatorio.');
      const reason = normalizeText(input['reason']);
      if (reason.length < 5 || reason.length > 500) {
        throw new ApplicationError('VALIDATION_ERROR', 'El motivo debe tener entre 5 y 500 caracteres.');
      }
      mapReview(await repository.review(applicationId, actor.id, { approve: false, reason }));
      const detail = await reviewable(applicationId);
      audit({ type: 'courier_application_rejected', email: maskEmail(detail.applicantEmail), userId: detail.userId, actorId: actor.id });
      await notifyDecision(detail, false, reason);
      return detail;
    },
  };
}

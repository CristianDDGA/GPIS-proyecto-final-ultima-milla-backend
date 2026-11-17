import type { PrismaDatabaseClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type {
  ApplicationListFilter,
  ApplicationRepository,
  AttachFileResult,
  CancelResult,
  ReviewDecision,
  ReviewResult,
  SaveDraftResult,
  StoredFile,
  SubmitResult,
} from '../../application/ports/application.repository.port.js';
import type {
  ApplicationData,
  ApplicationDetail,
  ApplicationFileInfo,
  ApplicationStatus,
  CourierApplication,
  FileKind,
  ImageType,
  VehicleType,
} from '../../domain/application.js';
import { getSqlState } from '../../../../shared/sql-state.js';
import { ApplicationError } from '../../domain/application.errors.js';

interface ApplicationRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: string;
  readonly full_name: string;
  readonly national_id: string;
  readonly phone: string;
  readonly birth_date: string;
  readonly vehicle_type: string;
  readonly license_number: string;
  readonly license_category: string;
  readonly license_expires_on: string;
  readonly submitted_at: Date | null;
  readonly reviewed_at: Date | null;
  readonly rejection_reason: string | null;
  readonly approved_capacity: number | null;
  readonly created_at: Date;
  readonly applicant_email: string | null;
  readonly applicant_name: string | null;
  readonly files: ReadonlyArray<{ kind: string; content_type: string; size_bytes: number; uploaded_at: string }> | null;
}

interface FileRow {
  readonly kind: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly storage_key: string;
}

const SAVE_RESULTS = new Set(['OK', 'NOT_CLIENT', 'EMAIL_NOT_VERIFIED', 'ALREADY_PENDING', 'DUPLICATE_NATIONAL_ID']);
const ATTACH_RESULTS = new Set(['OK', 'NO_DRAFT']);
const SUBMIT_RESULTS = new Set(['OK', 'NO_DRAFT', 'MISSING_FILES', 'LICENSE_EXPIRED', 'UNDERAGE', 'DUPLICATE_NATIONAL_ID']);
const CANCEL_RESULTS = new Set(['OK', 'NOT_FOUND']);
const REVIEW_RESULTS = new Set(['OK', 'NOT_FOUND', 'NOT_PENDING', 'NOT_CLIENT', 'FORBIDDEN']);

function toResult<T extends string>(value: string | undefined, allowed: Set<string>): T {
  if (value === undefined || !allowed.has(value)) throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
  return value as T;
}

function mapFiles(row: ApplicationRow): ApplicationFileInfo[] {
  return (row.files ?? []).map((file) => ({
    kind: file.kind as FileKind,
    contentType: file.content_type as ImageType,
    sizeBytes: file.size_bytes,
    uploadedAt: new Date(file.uploaded_at).toISOString(),
  }));
}

function mapApplication(row: ApplicationRow): CourierApplication {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status as ApplicationStatus,
    fullName: row.full_name,
    nationalId: row.national_id,
    phone: row.phone,
    birthDate: row.birth_date,
    vehicleType: row.vehicle_type as VehicleType,
    licenseNumber: row.license_number,
    licenseCategory: row.license_category,
    licenseExpiresOn: row.license_expires_on,
    files: mapFiles(row),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    rejectionReason: row.rejection_reason,
    approvedCapacity: row.approved_capacity,
    createdAt: row.created_at.toISOString(),
  };
}

function mapDetail(row: ApplicationRow): ApplicationDetail {
  return { ...mapApplication(row), applicantEmail: row.applicant_email ?? '', applicantName: row.applicant_name };
}

function mapFile(row: FileRow): StoredFile {
  return {
    kind: row.kind as FileKind,
    contentType: row.content_type as ImageType,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storageKey: row.storage_key,
  };
}

export class PrismaApplicationRepository implements ApplicationRepository {
  constructor(private readonly database: PrismaDatabaseClient) {}

  async saveDraft(userId: string, data: ApplicationData): Promise<SaveDraftResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.save_courier_application_draft(
          ${userId}::uuid, ${data.fullName}::text, ${data.nationalId}::text, ${data.phone}::text, ${data.birthDate}::date,
          ${data.vehicleType}::text, ${data.licenseNumber}::text, ${data.licenseCategory}::text, ${data.licenseExpiresOn}::date
        ) AS result
      `;
      return toResult<SaveDraftResult>(rows[0]?.result, SAVE_RESULTS);
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error;
      if (getSqlState(error) === '23505') return 'DUPLICATE_NATIONAL_ID';
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async attachFile(userId: string, file: StoredFile): Promise<AttachFileResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.attach_courier_application_file(
          ${userId}::uuid, ${file.kind}::text, ${file.contentType}::text, ${file.sizeBytes}::integer, ${file.sha256}::text, ${file.storageKey}::text
        ) AS result
      `;
      return toResult<AttachFileResult>(rows[0]?.result, ATTACH_RESULTS);
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async submit(userId: string): Promise<SubmitResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.submit_courier_application(${userId}::uuid) AS result
      `;
      return toResult<SubmitResult>(rows[0]?.result, SUBMIT_RESULTS);
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error;
      if (getSqlState(error) === '23505') return 'DUPLICATE_NATIONAL_ID';
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async cancel(userId: string): Promise<CancelResult> {
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.cancel_courier_application(${userId}::uuid) AS result
      `;
      return toResult<CancelResult>(rows[0]?.result, CANCEL_RESULTS);
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async review(applicationId: string, reviewerId: string, decision: ReviewDecision): Promise<ReviewResult> {
    const reason = decision.approve ? null : decision.reason;
    const capacity = decision.approve ? decision.capacity : null;
    try {
      const rows = await this.database.$queryRaw<Array<{ result: string }>>`
        SELECT logistica.review_courier_application(
          ${applicationId}::uuid, ${reviewerId}::uuid, ${decision.approve}::boolean, ${reason}::text, ${capacity}::integer
        ) AS result
      `;
      return toResult<ReviewResult>(rows[0]?.result, REVIEW_RESULTS);
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async findLatestByUser(userId: string): Promise<CourierApplication | null> {
    try {
      const rows = await this.database.$queryRaw<ApplicationRow[]>`
        SELECT a.id, a.user_id, a.status, a.full_name, a.national_id, a.phone,
               to_char(a.birth_date, 'YYYY-MM-DD') AS birth_date, a.vehicle_type, a.license_number, a.license_category,
               to_char(a.license_expires_on, 'YYYY-MM-DD') AS license_expires_on,
               a.submitted_at, a.reviewed_at, a.rejection_reason, a.approved_capacity, a.created_at,
               NULL::text AS applicant_email, NULL::text AS applicant_name,
               COALESCE((
                 SELECT json_agg(json_build_object('kind', f.kind, 'content_type', f.content_type, 'size_bytes', f.size_bytes, 'uploaded_at', f.uploaded_at) ORDER BY f.kind)
                 FROM logistica.courier_application_files f WHERE f.application_id = a.id
               ), '[]'::json) AS files
        FROM logistica.courier_applications a
        WHERE a.user_id = ${userId}::uuid
        ORDER BY a.created_at DESC, a.id
        LIMIT 1
      `;
      const row = rows[0];
      return row ? mapApplication(row) : null;
    } catch {
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async findDetail(applicationId: string): Promise<ApplicationDetail | null> {
    try {
      const rows = await this.database.$queryRaw<ApplicationRow[]>`
        SELECT a.id, a.user_id, a.status, a.full_name, a.national_id, a.phone,
               to_char(a.birth_date, 'YYYY-MM-DD') AS birth_date, a.vehicle_type, a.license_number, a.license_category,
               to_char(a.license_expires_on, 'YYYY-MM-DD') AS license_expires_on,
               a.submitted_at, a.reviewed_at, a.rejection_reason, a.approved_capacity, a.created_at,
               u.email AS applicant_email, u.display_name AS applicant_name,
               COALESCE((
                 SELECT json_agg(json_build_object('kind', f.kind, 'content_type', f.content_type, 'size_bytes', f.size_bytes, 'uploaded_at', f.uploaded_at) ORDER BY f.kind)
                 FROM logistica.courier_application_files f WHERE f.application_id = a.id
               ), '[]'::json) AS files
        FROM logistica.courier_applications a
        JOIN logistica.app_users u ON u.id = a.user_id
        WHERE a.id = ${applicationId}::uuid AND a.status <> 'borrador'
      `;
      const row = rows[0];
      return row ? mapDetail(row) : null;
    } catch {
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async list(filter: ApplicationListFilter): Promise<{ items: readonly ApplicationDetail[]; total: number }> {
    const status = filter.status ?? null;
    const q = filter.q ?? null;
    try {
      const rows = await this.database.$queryRaw<ApplicationRow[]>`
        SELECT a.id, a.user_id, a.status, a.full_name, a.national_id, a.phone,
               to_char(a.birth_date, 'YYYY-MM-DD') AS birth_date, a.vehicle_type, a.license_number, a.license_category,
               to_char(a.license_expires_on, 'YYYY-MM-DD') AS license_expires_on,
               a.submitted_at, a.reviewed_at, a.rejection_reason, a.approved_capacity, a.created_at,
               u.email AS applicant_email, u.display_name AS applicant_name,
               COALESCE((
                 SELECT json_agg(json_build_object('kind', f.kind, 'content_type', f.content_type, 'size_bytes', f.size_bytes, 'uploaded_at', f.uploaded_at) ORDER BY f.kind)
                 FROM logistica.courier_application_files f WHERE f.application_id = a.id
               ), '[]'::json) AS files
        FROM logistica.courier_applications a
        JOIN logistica.app_users u ON u.id = a.user_id
        WHERE a.status <> 'borrador'
          AND (${status}::text IS NULL OR a.status = ${status}::text)
          AND (${q}::text IS NULL OR position(lower(${q}::text) in lower(a.full_name || ' ' || coalesce(u.email, '') || ' ' || a.national_id)) > 0)
        ORDER BY (a.status = 'pendiente') DESC, coalesce(a.submitted_at, a.created_at) DESC, a.id
        LIMIT ${filter.limit}::integer OFFSET ${filter.offset}::integer
      `;
      const counts = await this.database.$queryRaw<Array<{ total: number }>>`
        SELECT count(*)::integer AS total
        FROM logistica.courier_applications a
        JOIN logistica.app_users u ON u.id = a.user_id
        WHERE a.status <> 'borrador'
          AND (${status}::text IS NULL OR a.status = ${status}::text)
          AND (${q}::text IS NULL OR position(lower(${q}::text) in lower(a.full_name || ' ' || coalesce(u.email, '') || ' ' || a.national_id)) > 0)
      `;
      return { items: rows.map(mapDetail), total: Number(counts[0]?.total ?? 0) };
    } catch {
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async findFileByUser(userId: string, kind: FileKind): Promise<StoredFile | null> {
    try {
      const rows = await this.database.$queryRaw<FileRow[]>`
        SELECT f.kind, f.content_type, f.size_bytes, f.sha256, f.storage_key
        FROM logistica.courier_application_files f
        WHERE f.kind = ${kind}::text
          AND f.application_id = (
            SELECT a.id FROM logistica.courier_applications a
            WHERE a.user_id = ${userId}::uuid ORDER BY a.created_at DESC, a.id LIMIT 1
          )
      `;
      const row = rows[0];
      return row ? mapFile(row) : null;
    } catch {
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }

  async findFileByApplication(applicationId: string, kind: FileKind): Promise<StoredFile | null> {
    try {
      const rows = await this.database.$queryRaw<FileRow[]>`
        SELECT f.kind, f.content_type, f.size_bytes, f.sha256, f.storage_key
        FROM logistica.courier_application_files f
        JOIN logistica.courier_applications a ON a.id = f.application_id
        WHERE f.application_id = ${applicationId}::uuid AND f.kind = ${kind}::text AND a.status <> 'borrador'
      `;
      const row = rows[0];
      return row ? mapFile(row) : null;
    } catch {
      throw new ApplicationError('PERSISTENCE_UNAVAILABLE');
    }
  }
}

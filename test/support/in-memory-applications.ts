import { randomUUID } from 'node:crypto';
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
} from '../../src/modules/courier-applications/application/ports/application.repository.port.js';
import {
  MIN_AGE_YEARS,
  subtractYears,
  todayInEcuador,
  type ApplicationData,
  type ApplicationDetail,
  type ApplicationStatus,
  type CourierApplication,
  type FileKind,
} from '../../src/modules/courier-applications/domain/application.js';
import type { InMemoryAuthRepository } from './in-memory-auth.js';

interface StoredApplication extends ApplicationData {
  readonly id: string;
  readonly userId: string;
  status: ApplicationStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  approvedCapacity: number | null;
  readonly createdAt: string;
  readonly seq: number;
}

interface FileEntry extends StoredFile {
  readonly uploadedAt: string;
}

const LIVE: readonly ApplicationStatus[] = ['pendiente', 'aprobada'];

/** Réplica en memoria de la semántica SQL de 009_courier_applications.sql. */
export class InMemoryApplicationRepository implements ApplicationRepository {
  private readonly applications: StoredApplication[] = [];
  private readonly files = new Map<string, Map<FileKind, FileEntry>>();
  private seq = 0;

  constructor(
    private readonly auth: InMemoryAuthRepository,
    private readonly today: () => string = () => todayInEcuador(),
  ) {}

  private open(userId: string): StoredApplication | undefined {
    return this.applications.find((item) => item.userId === userId && (item.status === 'borrador' || item.status === 'pendiente'));
  }

  private duplicateNationalId(nationalId: string, exceptId?: string, exceptUser?: string): boolean {
    return this.applications.some(
      (item) => item.nationalId === nationalId && LIVE.includes(item.status) && item.id !== exceptId && item.userId !== exceptUser,
    );
  }

  async saveDraft(userId: string, data: ApplicationData): Promise<SaveDraftResult> {
    const user = await this.auth.findRecordById(userId);
    if (!user?.isActive || user.role !== 'cliente') return 'NOT_CLIENT';
    if (!user.emailVerified) return 'EMAIL_NOT_VERIFIED';
    if (this.duplicateNationalId(data.nationalId, undefined, userId)) return 'DUPLICATE_NATIONAL_ID';
    const existing = this.open(userId);
    if (existing?.status === 'pendiente') return 'ALREADY_PENDING';
    if (existing) {
      Object.assign(existing, data);
      return 'OK';
    }
    this.seq += 1;
    this.applications.push({
      ...data,
      id: randomUUID(),
      userId,
      status: 'borrador',
      submittedAt: null,
      reviewedAt: null,
      rejectionReason: null,
      approvedCapacity: null,
      createdAt: new Date().toISOString(),
      seq: this.seq,
    });
    return 'OK';
  }

  async attachFile(userId: string, file: StoredFile): Promise<AttachFileResult> {
    const draft = this.applications.find((item) => item.userId === userId && item.status === 'borrador');
    if (!draft) return 'NO_DRAFT';
    const bucket = this.files.get(draft.id) ?? new Map<FileKind, FileEntry>();
    bucket.set(file.kind, { ...file, uploadedAt: new Date().toISOString() });
    this.files.set(draft.id, bucket);
    return 'OK';
  }

  async submit(userId: string): Promise<SubmitResult> {
    const user = await this.auth.findRecordById(userId);
    if (!user?.isActive || user.role !== 'cliente') return 'NO_DRAFT';
    const draft = this.applications.find((item) => item.userId === userId && item.status === 'borrador');
    if (!draft) return 'NO_DRAFT';
    if ((this.files.get(draft.id)?.size ?? 0) < 2) return 'MISSING_FILES';
    const today = this.today();
    if (draft.licenseExpiresOn <= today) return 'LICENSE_EXPIRED';
    if (draft.birthDate > subtractYears(today, MIN_AGE_YEARS)) return 'UNDERAGE';
    if (this.duplicateNationalId(draft.nationalId, draft.id)) return 'DUPLICATE_NATIONAL_ID';
    draft.status = 'pendiente';
    draft.submittedAt = new Date().toISOString();
    return 'OK';
  }

  async cancel(userId: string): Promise<CancelResult> {
    const existing = this.open(userId);
    if (!existing) return 'NOT_FOUND';
    existing.status = 'cancelada';
    return 'OK';
  }

  async review(applicationId: string, reviewerId: string, decision: ReviewDecision): Promise<ReviewResult> {
    const reviewer = await this.auth.findRecordById(reviewerId);
    if (!reviewer?.isActive || reviewer.role !== 'personal') return 'FORBIDDEN';
    const application = this.applications.find((item) => item.id === applicationId);
    if (!application) return 'NOT_FOUND';
    if (application.status !== 'pendiente') return 'NOT_PENDING';
    if (decision.approve) {
      const user = await this.auth.findRecordById(application.userId);
      if (!user?.isActive || user.role !== 'cliente') return 'NOT_CLIENT';
      this.auth.promoteToCourier(application.userId, application.fullName);
      application.status = 'aprobada';
      application.approvedCapacity = decision.capacity;
    } else {
      application.status = 'rechazada';
      application.rejectionReason = decision.reason;
    }
    application.reviewedAt = new Date().toISOString();
    return 'OK';
  }

  private toApplication(item: StoredApplication): CourierApplication {
    const files = [...(this.files.get(item.id)?.values() ?? [])]
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((file) => ({ kind: file.kind, contentType: file.contentType, sizeBytes: file.sizeBytes, uploadedAt: file.uploadedAt }));
    const { seq: _seq, ...rest } = item;
    return { ...rest, files };
  }

  private async toDetail(item: StoredApplication): Promise<ApplicationDetail> {
    const user = await this.auth.findRecordById(item.userId);
    return { ...this.toApplication(item), applicantEmail: user?.email ?? '', applicantName: user?.displayName ?? null };
  }

  async findLatestByUser(userId: string): Promise<CourierApplication | null> {
    const latest = this.applications.filter((item) => item.userId === userId).sort((a, b) => b.seq - a.seq)[0];
    return latest ? this.toApplication(latest) : null;
  }

  async findDetail(applicationId: string): Promise<ApplicationDetail | null> {
    const item = this.applications.find((candidate) => candidate.id === applicationId && candidate.status !== 'borrador');
    return item ? this.toDetail(item) : null;
  }

  async list(filter: ApplicationListFilter): Promise<{ items: readonly ApplicationDetail[]; total: number }> {
    const rows = await Promise.all(this.applications.filter((item) => item.status !== 'borrador').map((item) => this.toDetail(item)));
    const needle = filter.q?.toLowerCase();
    const matching = rows
      .filter((row) => (filter.status ? row.status === filter.status : true))
      .filter((row) => (needle ? `${row.fullName} ${row.applicantEmail} ${row.nationalId}`.toLowerCase().includes(needle) : true))
      .sort((a, b) => {
        const pending = Number(b.status === 'pendiente') - Number(a.status === 'pendiente');
        if (pending !== 0) return pending;
        return (b.submittedAt ?? b.createdAt).localeCompare(a.submittedAt ?? a.createdAt);
      });
    return { items: matching.slice(filter.offset, filter.offset + filter.limit), total: matching.length };
  }

  async findFileByUser(userId: string, kind: FileKind): Promise<StoredFile | null> {
    const latest = this.applications.filter((item) => item.userId === userId).sort((a, b) => b.seq - a.seq)[0];
    return latest ? (this.files.get(latest.id)?.get(kind) ?? null) : null;
  }

  async findFileByApplication(applicationId: string, kind: FileKind): Promise<StoredFile | null> {
    const item = this.applications.find((candidate) => candidate.id === applicationId && candidate.status !== 'borrador');
    return item ? (this.files.get(item.id)?.get(kind) ?? null) : null;
  }
}

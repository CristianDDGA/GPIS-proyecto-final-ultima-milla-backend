import type {
  ApplicationData,
  ApplicationDetail,
  ApplicationStatus,
  CourierApplication,
  FileKind,
  ImageType,
} from '../../domain/application.js';

export type SaveDraftResult = 'OK' | 'NOT_CLIENT' | 'EMAIL_NOT_VERIFIED' | 'ALREADY_PENDING' | 'DUPLICATE_NATIONAL_ID';
export type AttachFileResult = 'OK' | 'NO_DRAFT';
export type SubmitResult = 'OK' | 'NO_DRAFT' | 'MISSING_FILES' | 'LICENSE_EXPIRED' | 'UNDERAGE' | 'DUPLICATE_NATIONAL_ID';
export type CancelResult = 'OK' | 'NOT_FOUND';
export type ReviewResult = 'OK' | 'NOT_FOUND' | 'NOT_PENDING' | 'NOT_CLIENT' | 'FORBIDDEN';

export type ReviewDecision =
  | { readonly approve: true; readonly capacity: number }
  | { readonly approve: false; readonly reason: string };

export interface StoredFile {
  readonly kind: FileKind;
  readonly contentType: ImageType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
}

export interface ApplicationListFilter {
  readonly status?: ApplicationStatus;
  /** Texto contenido en el nombre, el correo o la cédula (sin distinguir mayúsculas). */
  readonly q?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ApplicationRepository {
  saveDraft(userId: string, data: ApplicationData): Promise<SaveDraftResult>;
  attachFile(userId: string, file: StoredFile): Promise<AttachFileResult>;
  submit(userId: string): Promise<SubmitResult>;
  cancel(userId: string): Promise<CancelResult>;
  review(applicationId: string, reviewerId: string, decision: ReviewDecision): Promise<ReviewResult>;
  /** La solicitud más reciente del usuario (cualquier estado), o null. */
  findLatestByUser(userId: string): Promise<CourierApplication | null>;
  /** Solo solicitudes ya enviadas (no borradores). */
  findDetail(applicationId: string): Promise<ApplicationDetail | null>;
  /** Solicitudes ya enviadas, las pendientes primero y luego las más recientes. */
  list(filter: ApplicationListFilter): Promise<{ readonly items: readonly ApplicationDetail[]; readonly total: number }>;
  /** Archivo de la solicitud más reciente del usuario (para que el dueño vea lo que subió). */
  findFileByUser(userId: string, kind: FileKind): Promise<StoredFile | null>;
  /** Archivo de una solicitud ya enviada (revisión del administrador). */
  findFileByApplication(applicationId: string, kind: FileKind): Promise<StoredFile | null>;
}

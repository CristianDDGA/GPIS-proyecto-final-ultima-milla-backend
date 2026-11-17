export type ApplicationErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'EMAIL_NOT_VERIFIED'
  | 'APPLICATION_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'NO_OPEN_APPLICATION'
  | 'ALREADY_PENDING'
  | 'MISSING_FILES'
  | 'NOT_PENDING'
  | 'DUPLICATE_NATIONAL_ID'
  | 'APPLICANT_NOT_CLIENT'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PERSISTENCE_UNAVAILABLE';

const DEFAULT_MESSAGES: Record<ApplicationErrorCode, string> = {
  VALIDATION_ERROR: 'Los datos enviados no son válidos.',
  UNAUTHORIZED: 'Se requiere autenticación válida.',
  FORBIDDEN: 'No tienes permisos para realizar esta acción.',
  EMAIL_NOT_VERIFIED: 'Debes verificar tu correo antes de solicitar ser conductor.',
  APPLICATION_NOT_FOUND: 'La solicitud no existe.',
  FILE_NOT_FOUND: 'El archivo no existe.',
  NO_OPEN_APPLICATION: 'No tienes una solicitud abierta. Guarda primero tus datos.',
  ALREADY_PENDING: 'Ya tienes una solicitud pendiente de revisión.',
  MISSING_FILES: 'Debes subir la foto de la licencia y tu foto antes de enviar la solicitud.',
  NOT_PENDING: 'La solicitud ya no está pendiente.',
  DUPLICATE_NATIONAL_ID: 'Ya existe una solicitud vigente con esa cédula.',
  APPLICANT_NOT_CLIENT: 'El solicitante ya no es un cliente; la solicitud no puede aprobarse.',
  FILE_TOO_LARGE: 'La imagen supera el límite de 5 MB.',
  UNSUPPORTED_MEDIA_TYPE: 'Solo se aceptan imágenes JPEG o PNG.',
  PERSISTENCE_UNAVAILABLE: 'El servicio no está disponible temporalmente.',
};

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message?: string,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'ApplicationError';
  }
}

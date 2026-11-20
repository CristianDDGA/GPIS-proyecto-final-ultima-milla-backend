export type SecurityEventType =
  | 'register'
  | 'email_verified'
  | 'login_success'
  | 'google_linked'
  | 'login_failed'
  | 'login_locked'
  | 'login_unverified'
  | 'logout'
  | 'password_reset'
  | 'password_changed'
  | 'admin_password_reset'
  | 'user_created_by_admin'
  | 'user_deactivated'
  | 'user_activated'
  | 'courier_application_submitted'
  | 'courier_application_cancelled'
  | 'courier_application_approved'
  | 'courier_application_rejected';

export interface SecurityEvent {
  readonly type: SecurityEventType;
  /** Correo con la parte local enmascarada (a***@dominio.com). Nunca contraseñas ni códigos. */
  readonly email?: string;
  readonly userId?: string;
  /** Administrador que ejecutó la acción, cuando aplica. */
  readonly actorId?: string;
  readonly detail?: string;
}

/** Registro de eventos de seguridad (auditoría operativa). No debe lanzar ni bloquear la petición. */
export type SecurityLog = (event: SecurityEvent) => void;

/** a***@dominio.com: permite reconocer la cuenta sin guardar el correo completo en los registros. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

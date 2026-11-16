import type { EmailMessage } from './ports/email-sender.port.js';
import type { CodePurpose } from './ports/auth.repository.port.js';

const APP_NAME = 'Última Milla';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

/** Correo con el código de 6 dígitos para verificar el correo o recuperar la clave. */
export function buildCodeEmail(input: {
  readonly to: string;
  readonly purpose: CodePurpose;
  readonly code: string;
  readonly ttlMinutes: number;
  readonly displayName: string | null;
}): EmailMessage {
  const greeting = input.displayName ? `Hola, ${input.displayName}:` : 'Hola:';
  const verify = input.purpose === 'verify_email';
  const subject = verify ? `${input.code} es tu código para verificar tu correo` : `${input.code} es tu código para recuperar tu contraseña`;
  const intro = verify
    ? `Usa este código para verificar tu correo en ${APP_NAME}.`
    : `Usa este código para restablecer tu contraseña en ${APP_NAME}.`;
  const outro = `El código caduca en ${input.ttlMinutes} minutos y solo puede usarse una vez. Si no lo solicitaste, ignora este mensaje.`;
  const text = `${greeting}\n\n${intro}\n\nCódigo: ${input.code}\n\n${outro}\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#0f172a">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(intro)}</p>
<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${escapeHtml(input.code)}</p>
<p style="color:#475569;font-size:14px">${escapeHtml(outro)}</p>
</div>`;
  return { to: input.to, subject, text, html };
}

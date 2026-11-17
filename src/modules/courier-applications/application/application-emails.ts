import type { EmailMessage } from '../../auth/application/ports/email-sender.port.js';

const APP_NAME = 'Última Milla';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function wrap(paragraphs: readonly string[]): { text: string; html: string } {
  const text = `${paragraphs.join('\n\n')}\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#0f172a">${paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('')}</div>`;
  return { text, html };
}

/** Aviso al solicitante cuando el administrador resuelve su solicitud de conductor. */
export function buildDecisionEmail(input: {
  readonly to: string;
  readonly name: string | null;
  readonly approved: boolean;
  readonly reason?: string;
}): EmailMessage {
  const greeting = input.name ? `Hola, ${input.name}:` : 'Hola:';
  if (input.approved) {
    const body = wrap([
      greeting,
      `Tu solicitud para ser conductor en ${APP_NAME} fue aprobada.`,
      'Inicia sesión de nuevo para ver tu panel de conductor.',
    ]);
    return { to: input.to, subject: 'Tu solicitud de conductor fue aprobada', ...body };
  }
  const body = wrap([
    greeting,
    `Tu solicitud para ser conductor en ${APP_NAME} fue rechazada.`,
    `Motivo: ${input.reason ?? 'no indicado'}`,
    'Puedes corregir tus datos y enviar una solicitud nueva desde la aplicación.',
  ]);
  return { to: input.to, subject: 'Tu solicitud de conductor fue rechazada', ...body };
}

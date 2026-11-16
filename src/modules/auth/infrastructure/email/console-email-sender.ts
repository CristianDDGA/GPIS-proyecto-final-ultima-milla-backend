import type { EmailMessage, EmailSender } from '../../application/ports/email-sender.port.js';

// Solo para desarrollo sin SMTP: escribe el correo (con su código) en la salida estándar.
// Nunca se usa en producción: la configuración exige SMTP cuando NODE_ENV=production.
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly write: (line: string) => void = (line) => { process.stdout.write(line); }) {}

  async send(message: EmailMessage): Promise<void> {
    this.write(`[correo de desarrollo] Para: ${message.to} | Asunto: ${message.subject}\n${message.text}\n`);
  }
}

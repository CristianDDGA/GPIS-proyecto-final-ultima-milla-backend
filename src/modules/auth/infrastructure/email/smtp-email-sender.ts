import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from '../../application/ports/email-sender.port.js';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** true: TLS implícito (puerto 465). false: STARTTLS si el servidor lo ofrece (587). */
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
  /** Solo para pruebas con un servidor SMTP local sin TLS válido. */
  readonly allowInsecureTls?: boolean;
}

// Tiempos cortos: un SMTP caído no debe dejar colgada la petición HTTP.
const CONNECTION_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 10_000;

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: config.password ?? '' } } : {}),
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      ...(config.allowInsecureTls ? { tls: { rejectUnauthorized: false } } : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

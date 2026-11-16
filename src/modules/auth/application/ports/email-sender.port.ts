export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailSender {
  /** Rechaza si el correo no pudo entregarse al servidor SMTP. */
  send(message: EmailMessage): Promise<void>;
}

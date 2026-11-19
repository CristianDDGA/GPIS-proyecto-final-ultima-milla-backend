import type { EmailMessage, EmailSender } from '../../auth/application/ports/email-sender.port.js';
import type { PendingNotification } from '../domain/flows.types.js';
import type { StoreOrderDetail } from '../domain/store.types.js';
import type { FlowsRepository } from './ports/flows.ports.js';
import type { StoreOrderRepository } from './ports/store.ports.js';

// Cola de correos al cliente (confirmación y cambios de estado). La base de datos guarda un aviso por cambio de
// estado dentro de la misma transacción; este proceso los reclama (SKIP LOCKED), los envía y los marca.

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const orderCode = (orderId: string): string => `#PED-${orderId.replace(/-/g, '').slice(0, 4).toUpperCase()}`;

const STATUS_TEXT: Record<string, string> = {
  en_camino: 'va en camino hacia tu dirección',
  entregado: 'fue entregado. Gracias por tu compra',
  entrega_fallida: 'no pudo entregarse en este intento. Puedes reprogramarlo desde la aplicación',
};

interface Rendered { readonly subject: string; readonly lines: readonly string[] }

function render(notification: PendingNotification, order: StoreOrderDetail | null): Rendered | null {
  const code = orderCode(notification.orderId);
  switch (notification.kind) {
    case 'order_confirmed': {
      if (order === null) return null;
      return {
        subject: `Recibimos tu pedido ${code}`,
        lines: [
          `Recibimos tu pedido ${code} para el ${order.deliveryDate} a las ${order.deliveryTime}.`,
          ...order.items.map((item) => `${item.quantity} x ${item.name}: ${money(item.lineTotalCents)}`),
          `Total a pagar contra entrega: ${money(order.totalCents)}.`,
        ],
      };
    }
    case 'order_cancelled':
      return { subject: `Pedido ${code} cancelado`, lines: [`Tu pedido ${code} fue cancelado y los productos volvieron al inventario.`] };
    case 'order_rescheduled':
      return {
        subject: `Pedido ${code} reprogramado`,
        lines: [`Tu pedido ${code} fue reprogramado${order ? ` para el ${order.deliveryDate} a las ${order.deliveryTime}` : ''}.`],
      };
    case 'order_status': {
      const text = STATUS_TEXT[notification.statusTo ?? ''];
      return text === undefined ? null : { subject: `Pedido ${code}: actualización`, lines: [`Tu pedido ${code} ${text}.`] };
    }
  }
}

export function buildNotificationEmail(notification: PendingNotification, order: StoreOrderDetail | null): EmailMessage | null {
  if (notification.email === null) return null;
  const rendered = render(notification, order);
  if (rendered === null) return null;
  const name = notification.displayName?.trim() || 'cliente';
  const text = [`Hola ${name},`, '', ...rendered.lines, '', 'Última milla'].join('\n');
  const html = `<p>Hola ${escapeHtml(name)},</p>${rendered.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}<p>Última milla</p>`;
  return { to: notification.email, subject: rendered.subject, text, html };
}

/** Solo las cuentas que confirmaron su correo con un código reciben avisos; el modo demo no envía nada. */
export function canEmail(notification: PendingNotification): boolean {
  return notification.email !== null && notification.emailVerifiedVia === 'code';
}

export interface NotificationWorkerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly onError?: (error: unknown) => void;
}

export class NotificationWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly flows: FlowsRepository,
    private readonly orders: StoreOrderRepository,
    private readonly mail: EmailSender,
    private readonly options: NotificationWorkerOptions = {},
  ) {}

  /** Procesa un lote y devuelve cuántos avisos reclamó. Nunca lanza: un fallo deja el aviso para reintento. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const batch = await this.flows.claimNotifications(this.options.batchSize ?? 10);
      for (const notification of batch) await this.deliver(notification);
      return batch.length;
    } catch (error: unknown) {
      this.options.onError?.(error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async deliver(notification: PendingNotification): Promise<void> {
    try {
      if (!canEmail(notification)) {
        await this.flows.finishNotification(notification.id, 'skipped');
        return;
      }
      const order = await this.orders.getOrder(notification.orderId, {});
      const message = buildNotificationEmail(notification, order);
      if (message === null) {
        await this.flows.finishNotification(notification.id, 'skipped');
        return;
      }
      await this.mail.send(message);
      await this.flows.finishNotification(notification.id, 'sent');
    } catch (error: unknown) {
      this.options.onError?.(error);
      try { await this.flows.finishNotification(notification.id, 'retry'); } catch (inner: unknown) { this.options.onError?.(inner); }
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.options.intervalMs ?? 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

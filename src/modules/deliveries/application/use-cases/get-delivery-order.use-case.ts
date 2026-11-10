import { DeliveryError } from '../../domain/delivery.errors.js';
import { validateOrderId, type DeliveryOrder } from '../../domain/delivery-order.js';
import type { DeliveryRepository } from '../ports/delivery.repository.js';

export class GetDeliveryOrderUseCase {
  constructor(
    private readonly repository: Pick<DeliveryRepository, 'findOrderById'>,
  ) {}

  async execute(rawOrderId: unknown): Promise<DeliveryOrder> {
    const orderId = validateOrderId(rawOrderId);
    const order = await this.repository.findOrderById(orderId);
    if (!order) {
      throw new DeliveryError('ORDER_NOT_FOUND');
    }
    return order;
  }
}

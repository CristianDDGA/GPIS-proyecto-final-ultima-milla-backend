import { Order } from '../../domain/order.entity.js';
import { OrderConflictError, OrderOutOfCoverageError, OrderValidationError, ZoneNotFoundError } from '../../domain/order.errors.js';
import { validateAddressText } from '../../../../shared/text-validation.js';
import type { OrderRepository } from '../ports/order.repository.port.js';
import type { OrderZonePort } from '../ports/order-zone.port.js';
import type { ZoneDeliveryGuard } from '../../../../shared/zone-delivery-guard.port.js';

export interface CreateOrderCommand {
  readonly zoneId: string;
  readonly deliveryAddress: string;
  readonly deliveryDate: string;
  readonly deliveryTime: string;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
}

export class CreateOrderUseCase {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly zonePort: OrderZonePort,
    /** Si el pedido trae pin, debe caer dentro de la cobertura de su zona. */
    private readonly zoneGuard?: ZoneDeliveryGuard,
  ) {}

  async execute(command: CreateOrderCommand): Promise<Order> {
    // Regla estricta solo al crear: la rehidratación de pedidos existentes no se bloquea.
    // Un valor no textual lo sigue rechazando Order.prepare con su mensaje original.
    let deliveryAddress = command.deliveryAddress;
    if (typeof deliveryAddress === 'string' && deliveryAddress.trim().length > 0) {
      const checked = validateAddressText(deliveryAddress, 'La dirección de entrega');
      if (!checked.ok) throw new OrderValidationError(checked.reason);
      deliveryAddress = checked.value;
    }
    const order = Order.prepare({
      zoneId: command.zoneId,
      deliveryAddress,
      deliveryDate: command.deliveryDate,
      deliveryTime: command.deliveryTime,
      latitude: command.latitude ?? null,
      longitude: command.longitude ?? null,
    });

    const zone = await this.zonePort.findById(order.zoneId);
    if (zone === null) {
      throw new ZoneNotFoundError(`No existe una zona con identificador '${order.zoneId}'.`);
    }
    if (zone.active === false) {
      throw new OrderConflictError('La zona seleccionada está inactiva.');
    }
    if (!zone.hasCoverage) {
      throw new OrderConflictError('La zona seleccionada aún no tiene cobertura definida en el mapa y no recibe pedidos.');
    }

    if (this.zoneGuard !== undefined && order.latitude != null && order.longitude != null) {
      const issue = await this.zoneGuard.check(order.zoneId, { latitude: order.latitude, longitude: order.longitude });
      if (issue === 'ZONE_OUT_OF_COVERAGE') throw new OrderOutOfCoverageError();
    }

    return await this.orderRepository.create(order);
  }
}

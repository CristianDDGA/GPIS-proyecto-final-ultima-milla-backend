import type { ActorContextPort } from './application/ports/actor-context.port.js';
import type { DeliveryRepository } from './application/ports/delivery.repository.js';
import { ChangeDeliveryStatusUseCase } from './application/use-cases/change-delivery-status.use-case.js';
import { CompleteRouteUseCase } from './application/use-cases/complete-route.use-case.js';
import { GetDeliveryOrderUseCase } from './application/use-cases/get-delivery-order.use-case.js';
import { DeliveryController } from './presentation/http/delivery.controller.js';
import {
  createDeliveryRouter,
  deliveryErrorHandler,
} from './presentation/http/delivery.router.js';

export interface DeliveriesModuleDependencies {
  readonly repository: DeliveryRepository;
  readonly actorContext: ActorContextPort;
}

export function createDeliveriesModule(dependencies: DeliveriesModuleDependencies) {
  const getOrder = new GetDeliveryOrderUseCase(dependencies.repository);
  const changeStatus = new ChangeDeliveryStatusUseCase(
    dependencies.repository,
    dependencies.actorContext,
  );
  const completeRoute = new CompleteRouteUseCase(
    dependencies.repository,
    dependencies.actorContext,
  );
  const controller = new DeliveryController(getOrder, changeStatus, completeRoute);

  return {
    router: createDeliveryRouter(controller),
    errorHandler: deliveryErrorHandler,
    useCases: {
      getOrder,
      changeStatus,
      completeRoute,
    },
  };
}

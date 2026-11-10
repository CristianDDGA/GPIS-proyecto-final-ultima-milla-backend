import {
  Router,
  type ErrorRequestHandler,
  type Request,
  type Response,
} from 'express';
import { DeliveryError } from '../../domain/delivery.errors.js';
import {
  sendDeliveryError,
  type DeliveryController,
} from './delivery.controller.js';

const DELIVERY_PATH_REGEX =
  /^\/(?:delivery-orders|delivery-status-changes|route-completions)(?:\/|$)/;

export const deliveryErrorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  next,
) => {
  if (response.headersSent || !DELIVERY_PATH_REGEX.test(request.path)) {
    next(error);
    return;
  }

  const parserType = (error as { type?: string } | null)?.type;
  if (parserType === 'entity.too.large') {
    const code = 'VALIDATION_ERROR';
    const message = 'El cuerpo JSON supera el límite de 32 KB.';
    response.status(413).json({
      code,
      message,
      error: { code, message },
    });
    return;
  }

  if (parserType === 'entity.parse.failed') {
    sendDeliveryError(
      new DeliveryError('VALIDATION_ERROR', 'El cuerpo debe contener JSON válido.'),
      response,
    );
    return;
  }

  sendDeliveryError(error, response);
};

export function createDeliveryRouter(controller: DeliveryController): Router {
  const router = Router();

  function route(
    operation: (request: Request, response: Response) => Promise<void>,
  ) {
    return (request: Request, response: Response) => {
      void operation(request, response).catch(error =>
        sendDeliveryError(error, response),
      );
    };
  }

  router.get(
    '/delivery-orders/:id',
    route((request, response) => controller.getOrder(request, response)),
  );
  router.post(
    '/delivery-status-changes',
    route((request, response) => controller.changeStatus(request, response)),
  );
  router.post(
    '/route-completions',
    route((request, response) => controller.completeRoute(request, response)),
  );

  return router;
}

import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { getRequestActor } from '../../../../bootstrap/auth.middleware.js';
import { MAX_PRODUCT_IMAGE_BYTES, type FileContent, type StoreActor, type StoreUseCases } from '../../application/store.use-cases.js';
import { StoreError, type StoreErrorCode } from '../../domain/store.errors.js';

const STATUS_BY_CODE: Record<StoreErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PRODUCT_NOT_FOUND: 404,
  CATEGORY_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  ZONE_NOT_FOUND: 404,
  IMAGE_NOT_FOUND: 404,
  DUPLICATE_SKU: 409,
  DUPLICATE_CATEGORY: 409,
  VERSION_CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
  ORDER_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  OPERATION_IN_PROGRESS: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PERSISTENCE_UNAVAILABLE: 503,
};

function sendStoreError(error: StoreError, response: Response): void {
  if (error.code === 'OPERATION_IN_PROGRESS') response.setHeader('Retry-After', '2');
  response.status(STATUS_BY_CODE[error.code]).json({
    code: error.code,
    message: error.message,
    error: { code: error.code, message: error.message },
    ...(error.details !== undefined ? { details: error.details } : {}),
  });
}

function currentActor(): StoreActor {
  const actor = getRequestActor();
  if (!actor) throw new StoreError('UNAUTHORIZED');
  return { id: actor.sub, role: actor.role };
}

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch((error: unknown) => {
      if (error instanceof StoreError) {
        sendStoreError(error, response);
        return;
      }
      next(error);
    });
  };
}

function query(request: Request): Record<string, unknown> {
  return request.query as Record<string, unknown>;
}

function sendImage(response: Response, file: FileContent): void {
  response.status(200);
  response.setHeader('Content-Type', file.contentType);
  response.setHeader('Content-Length', String(file.bytes.length));
  response.setHeader('Content-Disposition', 'inline');
  // El nombre es aleatorio y el contenido no cambia nunca: el navegador puede guardarlo mucho tiempo.
  response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // Una imagen subida nunca debe poder ejecutar nada si el navegador la abre directamente.
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.end(Buffer.from(file.bytes));
}

// Acepta el cuerpo binario solo con Content-Type de imagen; cualquier otro tipo deja el cuerpo sin interpretar.
const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: MAX_PRODUCT_IMAGE_BYTES });

export function createStoreRouter(useCases: StoreUseCases): Router {
  const router = Router();
  const param = (request: Request, name: string): unknown => request.params[name];

  // --- Imágenes: lectura pública (una etiqueta <img> no puede enviar la cabecera Authorization) ---
  router.get(
    '/images/:key',
    route(async (request, response) => {
      const key = param(request, 'key');
      const direct = typeof key === 'string' && /^[0-9a-f]{32}\.(?:jpg|png)$/.test(key) ? useCases.publicImageUrl(key) : null;
      if (direct !== null) {
        response.redirect(302, direct);
        return;
      }
      sendImage(response, await useCases.readImage(key));
    }),
  );

  // --- Catálogo (cliente y administrador) ---
  router.get('/categories', route(async (_request, response) => {
    response.status(200).json(await useCases.listCategories(currentActor()));
  }));

  router.get('/products', route(async (request, response) => {
    response.status(200).json(await useCases.listProducts(currentActor(), query(request)));
  }));

  router.get('/products/:id', route(async (request, response) => {
    response.status(200).json(await useCases.getProduct(currentActor(), param(request, 'id')));
  }));

  router.get('/delivery-slots', route(async (request, response) => {
    response.status(200).json(await useCases.deliverySlots(currentActor(), query(request)));
  }));

  // --- Pedidos ---
  router.post('/orders', route(async (request, response) => {
    const { replayed, order } = await useCases.placeOrder(currentActor(), request.body, request.get('Idempotency-Key'));
    if (replayed) response.setHeader('Idempotent-Replayed', 'true');
    response.status(replayed ? 200 : 201).json(order);
  }));

  router.get('/orders', route(async (request, response) => {
    response.status(200).json(await useCases.listOrders(currentActor(), query(request)));
  }));

  router.get('/orders/:id', route(async (request, response) => {
    response.status(200).json(await useCases.getOrder(currentActor(), param(request, 'id')));
  }));

  // --- Administración del catálogo (el RBAC global exige rol personal en /admin) ---
  router.get('/admin/categories', route(async (_request, response) => {
    response.status(200).json(await useCases.adminListCategories(currentActor()));
  }));

  router.post('/admin/categories', route(async (request, response) => {
    response.status(201).json(await useCases.adminCreateCategory(currentActor(), request.body));
  }));

  router.patch('/admin/categories/:id', route(async (request, response) => {
    response.status(200).json(await useCases.adminUpdateCategory(currentActor(), param(request, 'id'), request.body));
  }));

  router.get('/admin/products', route(async (request, response) => {
    response.status(200).json(await useCases.adminListProducts(currentActor(), query(request)));
  }));

  router.post('/admin/products', route(async (request, response) => {
    response.status(201).json(await useCases.adminCreateProduct(currentActor(), request.body));
  }));

  router.get('/admin/products/:id', route(async (request, response) => {
    response.status(200).json(await useCases.adminGetProduct(currentActor(), param(request, 'id')));
  }));

  router.patch('/admin/products/:id', route(async (request, response) => {
    response.status(200).json(await useCases.adminUpdateProduct(currentActor(), param(request, 'id'), request.body));
  }));

  router.post('/admin/products/:id/stock-adjustments', route(async (request, response) => {
    response.status(200).json(await useCases.adminAdjustStock(currentActor(), param(request, 'id'), request.body));
  }));

  router.get('/admin/products/:id/events', route(async (request, response) => {
    response.status(200).json(await useCases.adminProductEvents(currentActor(), param(request, 'id')));
  }));

  router.put(
    '/admin/products/:id/image',
    rawImage,
    route(async (request, response) => {
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body)) throw new StoreError('UNSUPPORTED_MEDIA_TYPE');
      const product = await useCases.adminUploadImage(currentActor(), param(request, 'id'), request.query['expectedVersion'], body);
      response.status(200).json(product);
    }),
  );

  router.delete('/admin/products/:id/image', route(async (request, response) => {
    response.status(200).json(await useCases.adminRemoveImage(currentActor(), param(request, 'id'), request.query['expectedVersion']));
  }));

  router.get('/admin/settings', route(async (_request, response) => {
    response.status(200).json(await useCases.adminGetSettings(currentActor()));
  }));

  router.put('/admin/settings', route(async (request, response) => {
    response.status(200).json(await useCases.adminUpdateSettings(currentActor(), request.body));
  }));

  return router;
}

/** Solo responde a rutas /store: un error del módulo, o una imagen demasiado grande, sale con el sobre JSON común. */
export const storeErrorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (!request.path.startsWith('/store/') && request.path !== '/store') {
    next(error);
    return;
  }
  if (error instanceof StoreError) {
    sendStoreError(error, response);
    return;
  }
  const parserError = error as { type?: string } | null;
  if (parserError?.type === 'entity.too.large') {
    sendStoreError(new StoreError('FILE_TOO_LARGE', 'La imagen supera el límite de 5 MB.'), response);
    return;
  }
  next(error);
};

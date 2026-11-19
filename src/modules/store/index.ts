import type { ErrorRequestHandler, Router } from 'express';
import type { EmailSender } from '../auth/application/ports/email-sender.port.js';
import { StoreFlowsUseCases } from './application/flows.use-cases.js';
import { NotificationWorker, type NotificationWorkerOptions } from './application/notification-worker.js';
import { StoreUseCases } from './application/store.use-cases.js';
import type { FlowsRepository } from './application/ports/flows.ports.js';
import type { CatalogRepository, ProductImageStorage, StoreOrderRepository } from './application/ports/store.ports.js';
import { createStoreRouter, storeErrorHandler } from './presentation/http/store.router.js';

export interface StoreModuleDependencies {
  readonly catalog: CatalogRepository;
  readonly orders: StoreOrderRepository;
  readonly images: ProductImageStorage;
  /** Flujos por rol (cancelar, conductor, caja, direcciones, reportes). Sin esto solo existe el catálogo y el pedido. */
  readonly flows?: FlowsRepository;
  /** Con flujos y correo, se crea el proceso que envía los avisos al cliente. */
  readonly emailSender?: EmailSender;
  readonly notifications?: NotificationWorkerOptions;
  readonly now?: () => Date;
}

export interface StoreModule {
  readonly router: Router;
  readonly errorHandler: ErrorRequestHandler;
  readonly useCases: StoreUseCases;
  readonly flows?: StoreFlowsUseCases;
  readonly notificationWorker?: NotificationWorker;
}

export function createStoreModule(dependencies: StoreModuleDependencies): StoreModule {
  const useCases = new StoreUseCases(dependencies.catalog, dependencies.orders, dependencies.images);
  const flows = dependencies.flows
    ? new StoreFlowsUseCases(dependencies.flows, dependencies.orders, dependencies.images, dependencies.now)
    : undefined;
  const notificationWorker =
    dependencies.flows && dependencies.emailSender
      ? new NotificationWorker(dependencies.flows, dependencies.orders, dependencies.emailSender, dependencies.notifications)
      : undefined;
  return {
    router: createStoreRouter(useCases, flows),
    errorHandler: storeErrorHandler,
    useCases,
    ...(flows ? { flows } : {}),
    ...(notificationWorker ? { notificationWorker } : {}),
  };
}

export { NotificationWorker } from './application/notification-worker.js';

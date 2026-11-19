import type { ErrorRequestHandler, Router } from 'express';
import { StoreUseCases } from './application/store.use-cases.js';
import type { CatalogRepository, ProductImageStorage, StoreOrderRepository } from './application/ports/store.ports.js';
import { createStoreRouter, storeErrorHandler } from './presentation/http/store.router.js';

export interface StoreModuleDependencies {
  readonly catalog: CatalogRepository;
  readonly orders: StoreOrderRepository;
  readonly images: ProductImageStorage;
}

export interface StoreModule {
  readonly router: Router;
  readonly errorHandler: ErrorRequestHandler;
  readonly useCases: StoreUseCases;
}

export function createStoreModule(dependencies: StoreModuleDependencies): StoreModule {
  const useCases = new StoreUseCases(dependencies.catalog, dependencies.orders, dependencies.images);
  return { router: createStoreRouter(useCases), errorHandler: storeErrorHandler, useCases };
}

import type { ErrorRequestHandler, Router } from 'express';
import type { RouteRepository } from './application/ports/route.repository.port.js';
import { PlanRoutesUseCase } from './application/use-cases/plan-routes.use-case.js';
import { ListRoutesUseCase } from './application/use-cases/list-routes.use-case.js';
import { GetRouteUseCase } from './application/use-cases/get-route.use-case.js';
import { RouteController } from './presentation/http/route.controller.js';
import {
  ROUTE_PLANS_PATH,
  ROUTES_PATH,
  createRoutePlanRouter,
  createRouteRouter,
  routesJsonErrorHandler,
} from './presentation/http/route.router.js';

export * from './domain/route.entity.js';
export * from './domain/route.errors.js';
export * from './application/ports/route.repository.port.js';
export * from './application/use-cases/plan-routes.use-case.js';
export * from './application/use-cases/list-routes.use-case.js';
export * from './application/use-cases/get-route.use-case.js';
export * from './presentation/http/route.controller.js';
export * from './presentation/http/route.router.js';

export interface RoutesModule {
  readonly routers: ReadonlyArray<{ readonly basePath: string; readonly router: Router }>;
  readonly errorHandler: ErrorRequestHandler;
  readonly useCases: {
    readonly planRoutes: PlanRoutesUseCase;
    readonly listRoutes: ListRoutesUseCase;
    readonly getRoute: GetRouteUseCase;
  };
}

// Composes only Routes; persistence adapters are injected by the bootstrap entry.
export function createRoutesModule(repository: RouteRepository): RoutesModule {
  const planRoutes = new PlanRoutesUseCase(repository);
  const listRoutes = new ListRoutesUseCase(repository);
  const getRoute = new GetRouteUseCase(repository);
  const controller = new RouteController(planRoutes, listRoutes, getRoute);
  return {
    routers: [
      { basePath: ROUTE_PLANS_PATH, router: createRoutePlanRouter(controller) },
      { basePath: ROUTES_PATH, router: createRouteRouter(controller) },
    ],
    errorHandler: routesJsonErrorHandler,
    useCases: { planRoutes, listRoutes, getRoute },
  };
}

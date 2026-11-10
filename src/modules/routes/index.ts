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

import type { RouteOperationsRepository } from './application/ports/route-operations.repository.port.js';
import type { LatePlacementRepository } from './application/ports/late-placement.repository.port.js';
import { MoveOrderUseCase } from './application/use-cases/move-order.use-case.js';
import { ReorderStopsUseCase } from './application/use-cases/reorder-stops.use-case.js';
import { PlaceLateOrderUseCase } from './application/use-cases/place-late-order.use-case.js';
import { RouteOperationsController } from './presentation/http/route-operations.controller.js';
import {
  LATE_ORDER_PLACEMENTS_PATH,
  ROUTE_MOVES_PATH,
  ROUTE_STOP_ORDER_BASE_PATH,
  createLatePlacementRouter,
  createRouteMoveRouter,
  createStopOrderRouter,
  routeOperationsJsonErrorHandler,
} from './presentation/http/route-operations.router.js';

export * from './domain/route.entity.js';
export * from './domain/route-operation.entity.js';
export * from './application/ports/route-operations.repository.port.js';
export * from './application/ports/late-placement.repository.port.js';
export * from './application/use-cases/move-order.use-case.js';
export * from './application/use-cases/reorder-stops.use-case.js';
export * from './application/use-cases/place-late-order.use-case.js';
export * from './presentation/http/route-operations.controller.js';
export * from './presentation/http/route-operations.router.js';
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

export interface RouteOperationsModule {
  readonly routers: ReadonlyArray<{ readonly basePath: string; readonly router: Router }>;
  readonly errorHandler: ErrorRequestHandler;
  readonly useCases: {
    readonly moveOrder: MoveOrderUseCase;
    readonly reorderStops: ReorderStopsUseCase;
    readonly placeLateOrder: PlaceLateOrderUseCase;
  };
}

// Sprint 03 extension, composed apart so createRoutesModule (consumed by the shared API) keeps its signature.
export function createRouteOperationsModule(repositories: {
  readonly operations: RouteOperationsRepository;
  readonly latePlacements: LatePlacementRepository;
}): RouteOperationsModule {
  const moveOrder = new MoveOrderUseCase(repositories.operations);
  const reorderStops = new ReorderStopsUseCase(repositories.operations);
  const placeLateOrder = new PlaceLateOrderUseCase(repositories.latePlacements);
  const controller = new RouteOperationsController(moveOrder, reorderStops, placeLateOrder);
  return {
    routers: [
      { basePath: ROUTE_MOVES_PATH, router: createRouteMoveRouter(controller) },
      { basePath: ROUTE_STOP_ORDER_BASE_PATH, router: createStopOrderRouter(controller) },
      { basePath: LATE_ORDER_PLACEMENTS_PATH, router: createLatePlacementRouter(controller) },
    ],
    errorHandler: routeOperationsJsonErrorHandler,
    useCases: { moveOrder, reorderStops, placeLateOrder },
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

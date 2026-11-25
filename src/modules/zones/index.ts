import type { Router } from 'express';
import type { ZoneRepository } from './application/ports/zone.repository.port.js';
import { CreateZoneUseCase } from './application/use-cases/create-zone.use-case.js';
import { GetZoneUseCase } from './application/use-cases/get-zone.use-case.js';
import { ListZonesUseCase } from './application/use-cases/list-zones.use-case.js';
import { FindZoneForPointUseCase, SetZoneCoverageUseCase } from './application/use-cases/zone-coverage.use-cases.js';
import { SetZoneActiveUseCase } from './application/use-cases/set-zone-active.use-case.js';
import { ZoneController } from './presentation/http/zone.controller.js';
import { createZoneRouter } from './presentation/http/zone.router.js';

export * from './domain/zone.entity.js';
export * from './domain/zone.errors.js';
export * from './application/ports/zone.repository.port.js';
export * from './application/use-cases/create-zone.use-case.js';
export * from './application/use-cases/get-zone.use-case.js';
export * from './application/use-cases/list-zones.use-case.js';
export * from './application/use-cases/zone-coverage.use-cases.js';
export * from './application/use-cases/set-zone-active.use-case.js';
export * from './application/zone-delivery-guard.service.js';
export * from './infrastructure/postgres/prisma-zone.repository.js';
export * from './infrastructure/postgres/in-memory-zone.repository.js';
export * from './presentation/http/zone.controller.js';
export * from './presentation/http/zone.router.js';

export interface ZonesModule {
  readonly repository: ZoneRepository;
  readonly controller: ZoneController;
  readonly router: Router;
  readonly useCases: {
    readonly createZone: CreateZoneUseCase;
    readonly getZone: GetZoneUseCase;
    readonly listZones: ListZonesUseCase;
    readonly setCoverage: SetZoneCoverageUseCase;
    readonly findForPoint: FindZoneForPointUseCase;
    readonly setActive: SetZoneActiveUseCase;
  };
}

export function createZonesModule(repository: ZoneRepository): ZonesModule {
  const createZone = new CreateZoneUseCase(repository);
  const getZone = new GetZoneUseCase(repository);
  const listZones = new ListZonesUseCase(repository);
  const setCoverage = new SetZoneCoverageUseCase(repository);
  const findForPoint = new FindZoneForPointUseCase(repository);
  const setActive = new SetZoneActiveUseCase(repository);
  const controller = new ZoneController(createZone, getZone, listZones, setCoverage, findForPoint, setActive);
  const router = createZoneRouter(controller);

  return {
    repository,
    controller,
    router,
    useCases: {
      createZone,
      getZone,
      listZones,
      setCoverage,
      findForPoint,
      setActive,
    },
  };
}

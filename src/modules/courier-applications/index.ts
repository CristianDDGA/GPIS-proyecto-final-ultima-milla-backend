import type { ErrorRequestHandler, Router } from 'express';
import type { EmailSender } from '../auth/application/ports/email-sender.port.js';
import type { SecurityLog } from '../auth/application/ports/security-log.port.js';
import type { TokenRevocationStore } from '../auth/application/ports/token-revocation.port.js';
import { createApplicationUseCases, type ApplicationUseCases } from './application/application.use-cases.js';
import type { ApplicationRepository } from './application/ports/application.repository.port.js';
import type { FileStorage } from './application/ports/file-storage.port.js';
import { applicationErrorHandler, createApplicationRouter } from './presentation/http/application.router.js';

export interface CourierApplicationsModuleDependencies {
  readonly repository: ApplicationRepository;
  readonly storage: FileStorage;
  readonly revocationStore: TokenRevocationStore;
  readonly emailSender?: EmailSender;
  readonly securityLog?: SecurityLog;
  /** Pedidos por viaje con los que nace un conductor aprobado (por defecto 10). */
  readonly defaultCapacity?: number;
  /** Fecha de hoy fija (YYYY-MM-DD); solo para pruebas. */
  readonly today?: () => string;
}

export interface CourierApplicationsModule {
  readonly router: Router;
  readonly errorHandler: ErrorRequestHandler;
  readonly useCases: ApplicationUseCases;
}

export function createCourierApplicationsModule(dependencies: CourierApplicationsModuleDependencies): CourierApplicationsModule {
  const useCases = createApplicationUseCases(dependencies.repository, dependencies.storage, dependencies.revocationStore, {
    ...(dependencies.emailSender ? { emailSender: dependencies.emailSender } : {}),
    ...(dependencies.securityLog ? { securityLog: dependencies.securityLog } : {}),
    ...(dependencies.defaultCapacity !== undefined ? { defaultCapacity: dependencies.defaultCapacity } : {}),
    ...(dependencies.today ? { today: dependencies.today } : {}),
  });
  return { router: createApplicationRouter(useCases), errorHandler: applicationErrorHandler, useCases };
}

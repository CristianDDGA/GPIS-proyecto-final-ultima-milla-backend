import { createAuthModule } from '../../src/modules/auth/index.js';
import type { AuthUser } from '../../src/modules/auth/domain/auth-user.entity.js';
import { PrismaAuthRepository } from '../../src/modules/auth/infrastructure/postgres/prisma-auth.repository.js';
import { CapturingEmailSender } from './in-memory-auth.js';

type Database = ConstructorParameters<typeof PrismaAuthRepository>[0];

export interface SeedAccountInput {
  readonly email: string;
  readonly password: string;
  readonly role: 'repartidor' | 'cliente';
  readonly displayName?: string;
}

/**
 * No hay endpoint HTTP para crear usuarios (los conductores entran por solicitud aprobada y solo hay un
 * administrador). Las pruebas con PostgreSQL real siembran cuentas con el caso de uso interno `registerByAdmin`.
 */
export function createPostgresSeeder(database: Database, jwtSecret: string): (input: SeedAccountInput) => Promise<AuthUser> {
  const module = createAuthModule({
    repository: new PrismaAuthRepository(database),
    jwtSecret,
    emailSender: new CapturingEmailSender(),
  });
  return (input) => module.useCases.registerByAdmin({ role: 'personal' }, input);
}

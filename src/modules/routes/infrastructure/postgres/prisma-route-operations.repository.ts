import type { PrismaDatabaseClient, PrismaQueryClient } from '../../../../infrastructure/postgres/prisma-client.port.js';
import type { LatePlacementCommand, RouteMoveCommand, StopOrderCommand } from '../../domain/route-operation.entity.js';
import { RouteNotFoundError, RouteOrderNotFoundError, RoutePersistenceUnavailableError } from '../../domain/route.errors.js';
import type { RouteOperationsRepository } from '../../application/ports/route-operations.repository.port.js';
import type { LatePlacementRepository } from '../../application/ports/late-placement.repository.port.js';
import { logisticaRouteOperationsSql as operationsSql } from './route-operations-sql.js';
import type { RouteSqlQuery } from './route-sql.js';
import { throwRoutePersistenceError } from './route-persistence.errors.js';

type Row = Record<string, unknown>;

const OPERATION_CONFLICT =
  'La operación entra en conflicto con el estado actual de la ruta o del pedido (zona/fecha, cupo, ruta iniciada o lista de paradas).';
const MOVE_UNAVAILABLE =
  'Persistencia no disponible temporalmente; el resultado del movimiento es incierto: consulta las rutas antes de reintentar.';
const OPERATION_VALIDATION = 'Los datos de la operación no cumplen las reglas de la base.';
const LATE_CONFLICT =
  'El pedido no está pendiente, la clave ya se usó con otros datos o la operación sigue en curso; para un intento nuevo usa una clave nueva.';

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new RoutePersistenceUnavailableError(); }
}

function rowsOf(records: unknown): Row[] {
  if (!Array.isArray(records)) throw new RoutePersistenceUnavailableError();
  return records.map((record: unknown) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new RoutePersistenceUnavailableError();
    return record as Row;
  });
}

async function query(client: PrismaQueryClient, statement: RouteSqlQuery): Promise<Row[]> {
  if (statement.strings.length !== statement.values.length + 1 || !Array.isArray(statement.strings.raw)) {
    throw new RoutePersistenceUnavailableError();
  }
  return rowsOf(await client.$queryRaw<unknown>(statement.strings, ...statement.values));
}

async function exists(client: PrismaQueryClient, statement: RouteSqlQuery): Promise<boolean> {
  const rows = await query(client, statement);
  const value = rows[0]?.['exists'];
  if (rows.length !== 1 || typeof value !== 'boolean') throw new RoutePersistenceUnavailableError();
  return value;
}

async function runCommand(client: PrismaQueryClient, statement: RouteSqlQuery): Promise<void> {
  const rows = await query(client, statement);
  if (rows.length !== 1) throw new RoutePersistenceUnavailableError();
}

// Orders and routes are never deleted (guard triggers), so an existence check before the command is stable.
// Command and read-back share one READ COMMITTED transaction: the answer reflects what was persisted.
export class PrismaRouteOperationsRepository implements RouteOperationsRepository, LatePlacementRepository {
  constructor(private readonly database: PrismaDatabaseClient) {}

  async moveOrder(command: RouteMoveCommand): Promise<{ routeId: unknown }> {
    try {
      return await this.database.$transaction(async (client) => {
        if (!(await exists(client, operationsSql.orderExists(command.orderId)))) throw new RouteOrderNotFoundError();
        if (!(await exists(client, operationsSql.routeExists(command.destinationRouteId)))) throw new RouteNotFoundError();
        await runCommand(client, operationsSql.moveOrder(command));
        const rows = await query(client, operationsSql.currentRouteOfOrder(command.orderId));
        if (rows.length !== 1) throw new RoutePersistenceUnavailableError(MOVE_UNAVAILABLE);
        return { routeId: rows[0]?.['routeId'] };
      });
    } catch (error: unknown) {
      // Any technical failure of a move is uncertain for the client: always say to check before retrying.
      if (error instanceof RoutePersistenceUnavailableError) throw new RoutePersistenceUnavailableError(MOVE_UNAVAILABLE);
      throwRoutePersistenceError(error, { validation: OPERATION_VALIDATION, conflict: OPERATION_CONFLICT, unavailable: MOVE_UNAVAILABLE });
    }
  }

  // One call: place_late_order locks the day, records the key and stores its answer atomically.
  async placeLateOrder(command: LatePlacementCommand): Promise<{ placement: unknown }> {
    try {
      if (!(await exists(this.database, operationsSql.orderExists(command.orderId)))) throw new RouteOrderNotFoundError();
      const rows = await query(this.database, operationsSql.placeLateOrder(command));
      if (rows.length !== 1) throw new RoutePersistenceUnavailableError();
      return { placement: parseJson(rows[0]?.['placement']) };
    } catch (error: unknown) {
      throwRoutePersistenceError(error, { validation: OPERATION_VALIDATION, conflict: LATE_CONFLICT });
    }
  }

  async reorderStops(command: StopOrderCommand): Promise<{ orderIds: unknown }> {
    try {
      return await this.database.$transaction(async (client) => {
        if (!(await exists(client, operationsSql.routeExists(command.routeId)))) throw new RouteNotFoundError();
        await runCommand(client, operationsSql.reorderRoute(command));
        const rows = await query(client, operationsSql.currentStopOrder(command.routeId));
        return { orderIds: rows.map((row) => row['orderId']) };
      });
    } catch (error: unknown) {
      throwRoutePersistenceError(error, { validation: OPERATION_VALIDATION, conflict: OPERATION_CONFLICT });
    }
  }
}

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Route,
  RoutePlanning,
  POSTGRES_INTEGER_MAX,
  type RouteProperties,
  type RouteSummary,
  type RouteStopRecord,
} from '../../src/modules/routes/domain/route.entity.js';
import {
  RouteIntegrityError,
  RouteValidationError,
} from '../../src/modules/routes/domain/route.errors.js';

const getRelativeDateStr = (daysDelta: number): string => {
  const d = new Date(Date.now() + daysDelta * 86_400_000);
  return d.toISOString().slice(0, 10);
};

const FUTURE_DATE = getRelativeDateStr(5);
const PAST_DATE = getRelativeDateStr(-5);
const VALID_ZONE_ID = 'a0000000-0000-4000-8000-000000000001';
const VALID_ROUTE_ID = 'b0000000-0000-4000-8000-000000000002';
const VALID_ORDER_ID_1 = 'c0000000-0000-4000-8000-000000000003';
const VALID_ORDER_ID_2 = 'c0000000-0000-4000-8000-000000000004';
const VALID_ORDER_ID_3 = 'c0000000-0000-4000-8000-000000000005';

const createValidRouteProps = (): RouteProperties => ({
  id: VALID_ROUTE_ID,
  zoneId: VALID_ZONE_ID,
  serviceDate: FUTURE_DATE,
  capacityLimit: 4,
  status: 'planificada',
  courierId: null,
  occupiedSlots: 0,
  createdAt: new Date('2026-11-12T10:00:00.000Z'),
  updatedAt: new Date('2026-11-12T10:00:00.000Z'),
  metadata: { priority: 'standard', region: 'norte' },
});

describe('Route Domain Unit Tests', () => {
  describe('Route Entity - Validation and Invariants', () => {
    test('permite crear una ruta válida con fecha futura y capacidad positiva', () => {
      const props = createValidRouteProps();
      const route = Route.create(props);

      assert.equal(route.id, VALID_ROUTE_ID);
      assert.equal(route.zoneId, VALID_ZONE_ID);
      assert.equal(route.serviceDate, FUTURE_DATE);
      assert.equal(route.capacityLimit, 4);
      assert.equal(route.status, 'planificada');
      assert.equal(route.courierId, null);
      assert.equal(route.occupiedSlots, 0);
      assert.equal(route.availableSlots, 4);
    });

    test('rechaza capacidades negativas o cero', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({ ...base, capacityLimit: -1 }),
        (err: unknown) => err instanceof RouteValidationError && /entero positivo/i.test(err.message),
      );

      assert.throws(
        () => Route.create({ ...base, capacityLimit: 0 }),
        (err: unknown) => err instanceof RouteValidationError && /entero positivo/i.test(err.message),
      );
    });

    test('rechaza capacidades no enteras o tipos inválidos', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({ ...base, capacityLimit: 3.5 }),
        (err: unknown) => err instanceof RouteValidationError,
      );

      assert.throws(
        () => Route.create({ ...base, capacityLimit: '4' as unknown as number }),
        (err: unknown) => err instanceof RouteValidationError,
      );
    });

    test('rechaza límites superiores que exceden el máximo entero de PostgreSQL', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({ ...base, capacityLimit: POSTGRES_INTEGER_MAX + 1 }),
        (err: unknown) => err instanceof RouteValidationError && /entero positivo/i.test(err.message),
      );
    });

    test('rechaza rutas con fechas de servicio pasadas', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({ ...base, serviceDate: PAST_DATE }),
        (err: unknown) => err instanceof RouteValidationError && /fecha pasada/i.test(err.message),
      );

      assert.throws(
        () => Route.prepare({ zoneId: VALID_ZONE_ID, serviceDate: '2020-01-01', capacityLimit: 5 }),
        (err: unknown) => err instanceof RouteValidationError && /fecha pasada/i.test(err.message),
      );
    });

    test('rechaza rutas con fechas que no pertenecen al calendario o formato inválido', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({ ...base, serviceDate: '2026-02-31' }),
        (err: unknown) => err instanceof RouteValidationError && /calendario/i.test(err.message),
      );

      assert.throws(
        () => Route.create({ ...base, serviceDate: '12-11-2026' }),
        (err: unknown) => err instanceof RouteValidationError && /YYYY-MM-DD/i.test(err.message),
      );
    });

    test('rechaza estados de ruta desconocidos', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({ ...base, status: 'estado_invalido' as unknown as RouteProperties['status'] }),
        (err: unknown) => err instanceof RouteValidationError && /estado de ruta desconocido/i.test(err.message),
      );
    });

    test('rechaza metadatos de fechas con orden cronológico inválido o fechas corruptas', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({
          ...base,
          createdAt: new Date('2026-11-12T12:00:00.000Z'),
          updatedAt: new Date('2026-11-12T10:00:00.000Z'),
        }),
        (err: unknown) => err instanceof RouteValidationError && /metadatos de fecha/i.test(err.message),
      );

      assert.throws(
        () => Route.create({ ...base, createdAt: new Date('fecha_invalida') }),
        (err: unknown) => err instanceof RouteValidationError,
      );
    });
  });

  describe('Slot Calculation and Stop Count Algorithm', () => {
    test('rechaza ocupaciones iniciales negativas', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({ ...base, occupiedSlots: -1 }),
        (err: unknown) => err instanceof RouteValidationError && /ocupación de ruta inválida/i.test(err.message),
      );
    });

    test('rechaza la creación de una ruta cuya ocupación supere su capacityLimit', () => {
      const base = createValidRouteProps();

      assert.throws(
        () => Route.create({ ...base, capacityLimit: 3, occupiedSlots: 4 }),
        (err: unknown) => err instanceof RouteIntegrityError && /supera su capacidad/i.test(err.message),
      );
    });

    test('calcula correctamente los cupos disponibles (availableSlots) y estado de aceptación', () => {
      const base = createValidRouteProps();
      const route = Route.create({ ...base, capacityLimit: 3, occupiedSlots: 1 });

      assert.equal(route.occupiedSlots, 1);
      assert.equal(route.capacityLimit, 3);
      assert.equal(route.availableSlots, 2);
      assert.equal(route.canAcceptStop(), true);
    });

    test('el algoritmo addStop incrementa occupiedSlots y decrementa availableSlots', () => {
      const base = createValidRouteProps();
      const route = Route.create({ ...base, capacityLimit: 2, occupiedSlots: 0 });

      route.addStop({
        orderId: VALID_ORDER_ID_1,
        position: 1,
        deliveryAddress: 'Av. Amazonas 100',
        deliveryDate: FUTURE_DATE,
        deliveryTime: '09:00',
        status: 'asignado_a_ruta',
      });

      assert.equal(route.occupiedSlots, 1);
      assert.equal(route.availableSlots, 1);
      assert.equal(route.canAcceptStop(), true);

      route.addStop({
        orderId: VALID_ORDER_ID_2,
        position: 2,
        deliveryAddress: 'Av. Shyris 200',
        deliveryDate: FUTURE_DATE,
        deliveryTime: '10:00',
        status: 'asignado_a_ruta',
      });

      assert.equal(route.occupiedSlots, 2);
      assert.equal(route.availableSlots, 0);
      assert.equal(route.canAcceptStop(), false);
    });

    test('el algoritmo addStop respeta estrictamente capacityLimit y lanza RouteIntegrityError al saturarse', () => {
      const base = createValidRouteProps();
      const route = Route.create({ ...base, capacityLimit: 1, occupiedSlots: 0 });

      route.addStop({
        orderId: VALID_ORDER_ID_1,
        position: 1,
        deliveryAddress: 'Calle Guayaquil 10',
        deliveryDate: FUTURE_DATE,
        deliveryTime: '11:00',
        status: 'asignado_a_ruta',
      });

      assert.throws(
        () => route.addStop({
          orderId: VALID_ORDER_ID_2,
          position: 2,
          deliveryAddress: 'Calle Cuenca 20',
          deliveryDate: FUTURE_DATE,
          deliveryTime: '11:30',
          status: 'asignado_a_ruta',
        }),
        (err: unknown) => err instanceof RouteIntegrityError && /supera su capacidad/i.test(err.message),
      );

      // occupiedSlots se mantiene exactamente en el límite sin desbordamiento
      assert.equal(route.occupiedSlots, 1);
    });

    test('el algoritmo addStop rechaza órdenes duplicadas en la misma ruta', () => {
      const base = createValidRouteProps();
      const route = Route.create({ ...base, capacityLimit: 3, occupiedSlots: 0 });

      const stop = {
        orderId: VALID_ORDER_ID_1,
        position: 1,
        deliveryAddress: 'Calle Bolivar 55',
        deliveryDate: FUTURE_DATE,
        deliveryTime: '12:00',
        status: 'asignado_a_ruta' as const,
      };

      route.addStop(stop);

      assert.throws(
        () => route.addStop(stop),
        (err: unknown) => err instanceof RouteIntegrityError && /pedido aparece dos veces/i.test(err.message),
      );
    });

    test('RoutePlanning.summary valida estrictamente la invariante occupiedSlots <= capacityLimit', () => {
      const summaryValid: RouteSummary = {
        id: VALID_ROUTE_ID,
        zoneId: VALID_ZONE_ID,
        serviceDate: FUTURE_DATE,
        capacityLimit: 3,
        status: 'planificada',
        courierId: null,
        occupiedSlots: 3,
      };

      const result = RoutePlanning.summary(summaryValid);
      assert.equal(result.occupiedSlots, 3);
      assert.equal(result.capacityLimit, 3);

      const summaryExceeded: RouteSummary = {
        ...summaryValid,
        occupiedSlots: 4,
      };

      assert.throws(
        () => RoutePlanning.summary(summaryExceeded),
        (err: unknown) => err instanceof RouteIntegrityError && /supera su capacidad/i.test(err.message),
      );
    });

    test('RoutePlanning.detail valida que el conteo de paradas coincida con occupiedSlots', () => {
      const summary: RouteSummary = {
        id: VALID_ROUTE_ID,
        zoneId: VALID_ZONE_ID,
        serviceDate: FUTURE_DATE,
        capacityLimit: 2,
        status: 'planificada',
        courierId: null,
        occupiedSlots: 2,
      };

      const stop1: RouteStopRecord = {
        orderId: VALID_ORDER_ID_1,
        position: 1,
        deliveryAddress: 'Calle A',
        deliveryDate: FUTURE_DATE,
        deliveryTime: '08:00',
        status: 'asignado_a_ruta',
        zoneId: VALID_ZONE_ID,
      };

      const stop2: RouteStopRecord = {
        orderId: VALID_ORDER_ID_2,
        position: 2,
        deliveryAddress: 'Calle B',
        deliveryDate: FUTURE_DATE,
        deliveryTime: '09:00',
        status: 'asignado_a_ruta',
        zoneId: VALID_ZONE_ID,
      };

      // Exactamente 2 paradas para occupiedSlots = 2 -> Aprobado
      const detail = RoutePlanning.detail(summary, [stop1, stop2]);
      assert.equal(detail.stops.length, 2);

      // Si se provee 1 parada cuando occupiedSlots = 2 -> Inconsistencia de integridad
      assert.throws(
        () => RoutePlanning.detail(summary, [stop1]),
        (err: unknown) => err instanceof RouteIntegrityError && /paradas vigentes no coinciden con la ocupación/i.test(err.message),
      );
    });
  });

  describe('Immutability and Defensive Copying', () => {
    test('los getters createdAt y updatedAt devuelven copias defensivas inmunes a mutación externa', () => {
      const input = createValidRouteProps();
      const route = Route.create(input);

      // Mutación a través de referencias retornadas por los getters
      const createdAtCopy = route.createdAt;
      const updatedAtCopy = route.updatedAt;

      createdAtCopy.setFullYear(1990);
      updatedAtCopy.setFullYear(1990);

      assert.equal(route.createdAt.getFullYear(), 2026);
      assert.equal(route.updatedAt.getFullYear(), 2026);
      assert.equal(route.toJSON().serviceDate, FUTURE_DATE);
    });

    test('mutar el objeto de fecha original suministrado al constructor no corrompe la entidad', () => {
      const originalCreatedAt = new Date('2026-11-12T10:00:00.000Z');
      const originalUpdatedAt = new Date('2026-11-12T10:00:00.000Z');
      const input: RouteProperties = {
        ...createValidRouteProps(),
        createdAt: originalCreatedAt,
        updatedAt: originalUpdatedAt,
      };

      const route = Route.create(input);

      // Mutación sobre el objeto de entrada posterior a la creación
      originalCreatedAt.setFullYear(1980);
      originalUpdatedAt.setFullYear(1980);

      assert.equal(route.createdAt.getFullYear(), 2026);
      assert.equal(route.updatedAt.getFullYear(), 2026);
    });

    test('el getter de metadata devuelve una copia defensiva aislada', () => {
      const input = createValidRouteProps();
      const route = Route.create(input);

      const metadataRetrieved = route.metadata;
      metadataRetrieved['priority'] = 'HACKED';
      metadataRetrieved['nuevaPropiedad'] = 'VALOR_EXTRA';

      assert.equal(route.metadata['priority'], 'standard');
      assert.equal(route.metadata['nuevaPropiedad'], undefined);
    });

    test('el getter de stops devuelve un arreglo defensivo que no permite mutar la colección interna', () => {
      const base = createValidRouteProps();
      const route = Route.create(base);

      route.addStop({
        orderId: VALID_ORDER_ID_1,
        position: 1,
        deliveryAddress: 'Ruta 1',
        deliveryDate: FUTURE_DATE,
        deliveryTime: '08:00',
        status: 'asignado_a_ruta',
      });

      const stopsArray = route.stops as unknown as Array<unknown>;
      assert.equal(stopsArray.length, 1);

      stopsArray.push({
        orderId: VALID_ORDER_ID_3,
        position: 2,
        deliveryAddress: 'Infiltrado',
      });

      assert.equal(stopsArray.length, 2);
      assert.equal(route.stops.length, 1);
      assert.equal(route.occupiedSlots, 1);
    });
  });
});


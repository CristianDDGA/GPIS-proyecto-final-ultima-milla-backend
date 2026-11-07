# Sprint 03 · Cristian Ango · Operación y ajustes de rutas (HU-RUT-02, HU-TAR-01)

Rama: `feature/sprint-03-cristian-route-operations`, creada desde `develop` en `c09a5e0` (merge del PR #7). Estado: en desarrollo.

## Base S2 recibida

| Dependencia | Revisión | Verificación |
|---|---|---|
| S2-C02/C03/C04/C05 · Módulo Routes (planificación, listado, detalle), factory `createRoutesApp`, entrada `routes.server.ts`, fragmento `sprint-02/routes.openapi.yaml` | Entrega `6666c27`, incorporada a develop con el merge `a610867` (PR #5) | Aceptación PostgreSQL 18 real del S2 (32/32). Regresión sobre `c09a5e0` el 07/11/2026 con Node 24.22.2: suite completa 102/102 |
| Paquete SQL canónico (`move_order`, `reorder_route`, `place_late_order`) | `db-proyecto`, manifiesto `.ci/database-package.json` | Funciones y permisos de `logistica_app` revisados en `003_commands.sql` y `004_permissions.sql`; sin cambios |

No hay dependencias de trabajo S3 de otro integrante. Las fixtures preparan repartidores y rutas iniciadas con funciones SQL originales.

## Contrato aditivo (S3-C01)

Fragmento: `docs/contracts/sprint-03/route-operations.openapi.yaml`. Solo añade paths; el contrato S2 queda congelado.

| Operación | Entrada | Respuesta |
|---|---|---|
| `POST /route-moves` | `orderId`, `destinationRouteId` (UUID) | 200 `{ orderId, routeId }` (destino confirmado en la misma transacción) |
| `PUT /routes/{id}/stop-order` | `orderIds`: UUID[] completo, sin repetidos | 200 `{ routeId, orderIds }` (orden leído tras `reorder_route`) |
| `POST /late-order-placements` | `orderId` UUID, `capacityLimit` entero ≥ 1; cabecera `Idempotency-Key` UUID | 200 `{ orderId, status: asignado_a_ruta, routeId }` o `{ orderId, status: pendiente, reason: NO_AVAILABLE_COURIER }` |

Errores con el sobre S2 `{ code, message, error: { code, message } }`: 400 `VALIDATION_ERROR`, 404 `ORDER_NOT_FOUND`/`ROUTE_NOT_FOUND`, 409 `DATA_CONFLICT`, 413, 500 `INTERNAL_SERVER_ERROR`, 503 `PERSISTENCE_UNAVAILABLE`.

Decisiones:

- **Composición.** `createRoutesModule` no cambia porque la composición global (`create-persisted-app.ts`) la consume. La ampliación es un módulo propio, `createRouteOperationsModule`, montado solo en `src/bootstrap/sprint02/routes.server.ts` (mismo puerto 3011 y configuración S2). Registrarlo en la API principal queda para la integración conjunta.
- **Respuesta persistida.** `move_order` y `reorder_route` devuelven `void`. El adaptador llama la función y lee el resultado en la misma transacción READ COMMITTED.
- **404.** Pedidos y rutas no se eliminan (triggers `guard_order`/`guard_route`), así que comprobar la existencia antes de la función es estable.
- **Idempotencia de la incorporación tardía.** `place_late_order` registra la clave con alcance `late:<orderId>`. La misma clave con otro `capacityLimit` para el mismo pedido da 409; con otro pedido es otra operación.

## Tareas

| Tarea | Estado | Resultado |
|---|---|---|
| S3-C01 | Hecho | Fragmento OpenAPI y este documento |
| S3-C02 | Hecho | Dominio `RouteOperations` (validación de UUID y lista completa sin repetidos; el resultado persistido debe coincidir con el comando), puerto `RouteOperationsRepository`, casos `MoveOrder` y `ReorderStops`, adaptador `PrismaRouteOperationsRepository` sobre `move_order`/`reorder_route` con lectura en la misma transacción |
| S3-C03 | Hecho | `RouteOperations.prepareLatePlacement`/`acceptLatePlacement` (dos resultados válidos: `asignado_a_ruta` con `routeId` o `pendiente` con `NO_AVAILABLE_COURIER`), puerto `LatePlacementRepository`, caso `PlaceLateOrder` y adaptador sobre `place_late_order` (idempotente y atómica por sí misma) |
| S3-C04 | Hecho | `RouteOperationsController`, routers `POST /route-moves`, `PUT /routes/{id}/stop-order`, `POST /late-order-placements` y manejador JSON propio; `createRouteOperationsModule` montado solo en `routes.server.ts` (3011). `createRoutesModule` y la composición global sin cambios; regresión 102/102 |
| S3-C05 | Hecho | `test/integration/sprint03/route-operations.integration.test.ts` y `route-operations.fixture.ts`: S3-CP-001 (9 pruebas) y S3-CP-002 (7 pruebas) con Jest + Supertest + PostgreSQL real; 16/16 y suite completa 118/118 (ver evidencia) |
| S3-C06 | No ejecutado | |

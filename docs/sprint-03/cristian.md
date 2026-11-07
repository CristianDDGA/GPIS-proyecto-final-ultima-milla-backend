# Sprint 03 · Cristian Ango · Operación y ajustes de rutas (HU-RUT-02, HU-TAR-01)

Rama: `feature/sprint-03-cristian-route-operations`, creada desde `develop` en `c09a5e0` (merge del PR #7). Entrega local del 07/11/2026, America/Guayaquil. Sin push, PR ni merge: la prueba manual, la revisión humana y la promoción conjunta siguen pendientes.

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
| S3-C06 | Hecho | Análisis estático S3-CP-006, reproducción limpia del MD, hallazgos y este documento. Sin defectos abiertos en el módulo |

## Arquitectura y reglas

- **Domain** (`route-operation.entity.ts`, `route.validation.ts`, `route.errors.ts`): sin Express, Prisma, SQL ni Node. Valida UUID, la lista completa de paradas (no vacía, sin repetidos, sin índices de UI), `capacityLimit` entero positivo (rechaza `"4"`, `0`, `1.5`) y la clave. Comprueba que la respuesta persistida coincide con el comando: el pedido quedó en la ruta destino, el orden confirmado es el solicitado y la incorporación tardía responde por el mismo pedido con uno de sus dos resultados. Si no, 500 sin detalle.
- **Application**: `MoveOrderUseCase`, `ReorderStopsUseCase` y `PlaceLateOrderUseCase`, que dependen solo de los puertos mínimos `RouteOperationsRepository` y `LatePlacementRepository`.
- **Infrastructure**: `PrismaRouteOperationsRepository` usa solo las funciones y vistas autorizadas a `logistica_app`, con parámetros enlazados. No escribe directamente `routes`, `route_stops` ni `orders`. Las funciones `void` se llaman en `FROM` para que el driver lea un entero.
- **Presentation**: `RouteOperationsController` y routers propios. Ignora campos extra, toma la clave de la cabecera y usa el sobre de errores S2.
- **Bootstrap**: `createRoutesApp` (en `routes.server.ts`) monta S2 + S3 sobre el `createApp` compartido. No se tocaron `create-app.ts`, `create-persisted-app.ts`, `server.ts`, Couriers, el paquete SQL, el lockfile ni los workflows.

Las reglas de negocio las aplica la base, que no se modificó: zona y fecha iguales, cupo, ruta antes de salida, un pedido en una sola ruta vigente, bloqueo del día e idempotencia. La API traduce sus rechazos a 409 y nunca reintenta por su cuenta.

## Evidencia de aceptación individual

### Ejecución oficial (07/11/2026 18:29–18:31, America/Guayaquil)

Entorno: Windows x64, Node 24.22.2, npm 11.19.1, Docker 29.7.2 (motor Linux), imagen PostgreSQL 18 fijada por digest del manifiesto, rol `logistica_app`. Código: commit `889a9fec8953fee5eddbb7b80da205cb6b13d8b7` de esta rama. Base S2: `6666c27` (merge `a610867`), sin código S3 de otro integrante.

| Comprobación | Resultado |
|---|---|
| `npm ci` | exit 0 (610 paquetes) |
| `db:verify`, `typecheck`, `typecheck:test`, `lint`, `build` | exit 0 |
| Harness: proyecto efímero `logistica_api_42860_1794094239803` | SQL original: PASS integridad, capacidad, fecha/zona, transiciones, historial, idempotencia, rollback y privilegios. PASS concurrencia al último cupo. Contenedor y red eliminados |
| Suite S3 (`--runTestsByPath …/sprint03/route-operations.integration.test.ts`) | 1 suite, 16/16, 21.6 s |
| Suite completa (`npm run test:integration:postgres`, mismo commit y entorno) | 7 suites, 118/118 (102 heredadas + 16 nuevas) |

### Casos

| Caso | Estado | Datos y esperado | Obtenido |
|---|---|---|---|
| S3-CP-001 | Aprobado | Dos rutas compatibles antes de salida, destinos de otra zona, otra fecha y sin cupo, un pedido sin ruta y una ruta `en_curso` preparada con `create_courier`, `assign_route` y `change_order_status` (actor demo). Movimiento y reordenamiento válidos se conservan; sin duplicados; los rechazos no dejan cambios ni modifican la ruta iniciada | 9/9. Movimiento al final del destino y fuera del origen; reordenamiento confirmado y estable con la misma lista. 409 para otra zona, otra fecha, sin cupo, misma ruta, pedido sin ruta, lista incompleta, sobrante o ajena, y sacar, meter o reordenar en la ruta iniciada; detalle idéntico antes y después. Dos movimientos simultáneos al último cupo: 200 y 409, capacidad respetada. 404 `ORDER_NOT_FOUND`/`ROUTE_NOT_FOUND`; 11 entradas inválidas con 400, JSON mal formado 400, cuerpo > 32 KB 413. Endpoints S2 intactos en la misma entrada |
| S3-CP-002 | Aprobado | Pedido pendiente para hoy (America/Guayaquil); variantes con ruta compatible con cupo, sin cupo con repartidor disponible y sin alternativa. Insertar o crear y asignar; si no hay repartidor, pendiente con motivo; sin superar cupos ni duplicar pedidos; replay estable | 7/7. Inserción en la ruta con cupo. Ruta nueva `asignada` al repartidor disponible con capacidad mín(capacityLimit, máximo del repartidor). `pendiente` + `NO_AVAILABLE_COURIER` sin crear rutas. La misma clave devuelve la respuesta guardada aunque luego aparezca un repartidor; una clave nueva sí lo asigna y no crea otro pedido. 409 para la misma clave con otro payload y para un pedido ya asignado; 404 para un pedido inexistente; 7 entradas inválidas con 400. Dos tardíos simultáneos con un cupo: uno entra y el otro espera. Base inaccesible: 503 sin detalles; en el movimiento, aviso de consultar antes de reintentar |
| S3-CP-006 | Aprobado (estático local) | TypeScript estricto, lint, build, contrato, arquitectura y alcance | `typecheck`, `typecheck:test`, `eslint .` y `build`: exit 0. OpenAPI 3.1 parseado: 3 operaciones, 46 referencias resueltas, ningún path S2 modificado. Domain/Application sin Express, Prisma ni Node, y Application sin dependencias de infraestructura ni presentación. Presentation no importa infraestructura. Sin imports de Zones/Orders/Couriers. Sin `INSERT/UPDATE/DELETE` ni `$queryRawUnsafe` en el módulo. Los 19 archivos cambiados respecto de `c09a5e0` están dentro de la lista exclusiva. `git diff --check` limpio |
| Regresión S1/S2 | Aprobado | Suites heredadas sin cambios | 102/102 dentro de la suite completa 118/118 |

No se ejecutaron SonarQube (no hay servidor remoto configurado) ni CI remoto. No se acredita revisión humana ni aceptación formal del sprint. La prueba manual en Postman queda pendiente.

## Hallazgos

- **H-01 · Integración en la API principal, pendiente y fuera de alcance.** Los endpoints S3 se sirven en la entrada de Routes (3011). Montarlos en `create-persisted-app.ts` (3000) es una línea en la composición global, que no es un archivo exclusivo en S3. Corresponde a la integración conjunta.
- **H-02 · Repartidores creados no disponibles.** `create_courier` deja `is_available = false`. Para que la incorporación tardía cree una ruta nueva, el repartidor debe marcarse disponible (`set_courier_availability`). Es el comportamiento del paquete SQL y lo respetan las pruebas.
- **H-03 · Alcance de la clave de la incorporación tardía.** `place_late_order` registra la clave por pedido (`late:<orderId>`). La misma clave con otro pedido se trata como una operación nueva. `logistica_app` no tiene SELECT sobre `operation_requests`, así que el contrato documenta la regla tal como la aplica la base.
- **H-04 · El replay devuelve la respuesta guardada, no el estado actual.** Si después el pedido se mueve, repetir la misma clave sigue devolviendo la ruta original, tal como exige el contrato. El estado vigente se consulta con `GET /routes/{id}`.
- **H-05 · Vaciar una ruta asignada la cancela.** Si `move_order` saca la última parada de una ruta `asignada`, la función la pasa a `cancelada` y el repartidor queda libre. Una ruta `planificada` vacía conserva su estado. Es una regla del paquete SQL, sin cambios.
- **H-06 · Sin restricción de "hoy".** `place_late_order` no limita la fecha del pedido; la HU lo plantea para el mismo día y las pruebas usan hoy en America/Guayaquil. No se añadió una regla que la base no tiene.

## Reproducción

En Windows con Docker Linux activo, desde el backend en esta rama, con Node 24.22.2:

```powershell
$env:DATABASE_PACKAGE_DIR = 'C:\Users\crisa\Documents\Proyecto-Gestion-De-Pruebas\db-proyecto'
npm ci
npm run typecheck
npm run typecheck:test
npm run lint
npm run build
node --env-file-if-exists=.env scripts/run-postgres-integration.mjs -- node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.config.js --runInBand --runTestsByPath test/integration/sprint03/route-operations.integration.test.ts
```

Sin `--` el harness ejecuta la suite completa. Sin `TEST_DATABASE_URL` (`npm run test:integration`) la suite S3 aparece como omitida: no usa repositorios en memoria.

Demo con una base aprobada (`DATABASE_URL` con `logistica_app`; `S2_ROUTES_PORT` opcional, 3011 por defecto):

```powershell
node --env-file-if-exists=.env --import=tsx src/bootstrap/sprint02/routes.server.ts
```

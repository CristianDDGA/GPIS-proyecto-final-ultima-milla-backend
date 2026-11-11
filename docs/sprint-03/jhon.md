# Sprint 03 · Jhon Jumbo · HU-ENT-01 (Estados de entrega)

## 1. Base recibida y alcance

- **Historia**: `HU-ENT-01` — Registro de recogida, tránsito y entrega, y finalización de ruta solo cuando todos sus pedidos estén entregados, manteniendo consistencia central y auditoría en PostgreSQL.
- **Rama de trabajo**: `feat/sprint-03-deliveries`.
- **Base Sprint 2 recibida**:
  - Rama base local: `4b2efb0` (`feat/sprint-02-couriers-assignments`).
  - Entrega S2 Couriers/Asignaciones (`S2-J02/J03/J04/J05`): commit verificado `153c77c91bc00f45caa2ba08f467f8069d737f4f` (`153c77c`).
  - Paquete canónico de base de datos PostgreSQL (`.ci/database-package.zip`): SHA-256 `334adc39ffc1c0c7771a9565d4c1b0469c9c63f184d3f2c3b88a09be34e48703`.
- **Alcance exclusivo modificado** (sin tocar `package.json`, `package-lock.json`, `tsconfig.json`, `create-app.ts`, módulos S1/S2, scripts comunes, SQL ni workflows):
  - `src/modules/deliveries/**`
  - `src/bootstrap/sprint03/deliveries.server.ts`
  - `test/integration/sprint03/deliveries.fixture.ts`
  - `test/integration/sprint03/deliveries.integration.test.ts`
  - `docs/contracts/sprint-03/deliveries.openapi.yaml`
  - `docs/sprint-03/jhon.md`

## 2. Registro de subtareas y commits

| Subtarea | Commit | Descripción |
|---|---|---|
| **S3-J01** | `a5b9567` | `docs(deliveries): define openapi contract and actor context port` |
| **S3-J02** | `fb7be2e` | `feat(deliveries): add delivery query, transition policies and use cases (S3-J02)` |
| **S3-J03** | `c715b57` | `feat(deliveries): implement transactional status change and route completion adapters (S3-J03)` |
| **S3-J04** | `9af4dc1` | `feat(deliveries): expose HTTP endpoints and standalone server (S3-J04)` |
| **Corrección SQL** | `5f2d403` | `fix(deliveries): disambiguate change_status_once jsonb result alias` |
| **S3-J05** | `36dbb71` | `test(deliveries): add S3-CP-003 integration tests and fixture (S3-J05)` |
| **S3-J06** | *este commit* | `docs(deliveries): record S3-CP-006 static analysis and delivery guide (S3-J06)` |

## 3. Arquitectura y diseño implementado

### Contrato HTTP (`docs/contracts/sprint-03/deliveries.openapi.yaml`)

- **`GET /delivery-orders/{id}`**: valida `id` UUID y responde `200` con `{ orderId, routeId, status, version, deliveredAt, updatedAt }` o `404 ORDER_NOT_FOUND`.
- **`POST /delivery-status-changes`**: exige encabezado `Idempotency-Key` UUID y cuerpo `{ orderId, newStatus, expectedVersion }` (cadena decimal positiva). Responde `200` con `{ orderId, status, version }`. Transiciones permitidas únicamente en orden estricto: `asignado_a_ruta -> recogido -> en_camino -> entregado`.
- **`POST /route-completions`**: exige `{ routeId }` UUID y responde `200` con `{ routeId, status }` cuando la ruta existe, está en un estado completable, el actor está autorizado y todos los pedidos de la ruta se encuentran en `entregado`.
- **Sobre de errores**: `400 VALIDATION_ERROR`, `403 FORBIDDEN`, `404 ORDER_NOT_FOUND` / `ROUTE_NOT_FOUND`, `409 DATA_CONFLICT` y `503 PERSISTENCE_UNAVAILABLE` (sin filtrar `SQLSTATE`).

### Clean Architecture y decisiones clave

- **Dominio (`src/modules/deliveries/domain/`)**: `actor.ts`, `delivery-order.ts` y `delivery.errors.ts` modelan roles permitidos (`isActorRole`), reglas de autorización para entrega y cierre de ruta (`assertCanCompleteRoute`), validación de transiciones/versiones decimales positivas y errores de dominio sin dependencias de Express ni Prisma.
- **Aplicación (`src/modules/deliveries/application/`)**: puertos `actor-context.port.ts` y `delivery.repository.ts`, más los casos de uso `get-delivery-order.use-case.ts`, `change-delivery-status.use-case.ts` y `complete-route.use-case.ts`.
- **Actor confiable (`ActorContextPort`)**: `StaticActorContext` (`src/modules/deliveries/infrastructure/context/static-actor.context.ts`) inyecta la identidad de servidor desde Bootstrap/test. No se aceptan `actorId` ni `role` desde el cuerpo HTTP. En pruebas reales pueden instanciarse dos apps independientes (`buildApp`) con actores de fixture distintos sobre PostgreSQL real.
- **Límite SQL y `bigint` (`src/modules/deliveries/infrastructure/postgres/`)**:
  - `delivery.mapper.ts` convierte versiones `bigint` a cadena decimal positiva en el límite SQL sin serializar `BigInt` en JSON ni redondear a `Number`.
  - `PrismaDeliveryRepository` (`prisma-delivery.repository.ts`) opera con el rol `logistica_app`, respetando que dicho rol no tiene `UPDATE` directo ni `SELECT` sobre `operation_requests`/`outbox_events`:
    - Usa `pg_advisory_xact_lock` dentro de transacción para serializar operaciones concurrentes sobre pedido/ruta.
    - Valida actor activo en `app_users` y ownership/política contra `orders`, `routes`, `couriers` y `current_route_stops`.
    - Delega transición idempotente y concurrencia optimista a `logistica.change_status_once(...) AS res(payload)`, preservando replay idempotente (misma clave y payload repite respuesta sin nueva transición/evento; misma clave y payload distinto o versión antigua genera `409 DATA_CONFLICT`).
    - Comprueba autorización y condición de todos entregados dentro del límite transaccional antes de ejecutar `logistica.complete_route(...)`.
- **Presentación y Bootstrap**:
  - `delivery.controller.ts` y `delivery.router.ts` en `src/modules/deliveries/presentation/http/`, reexportados en `src/modules/deliveries/index.ts`.
  - `src/bootstrap/sprint03/deliveries.server.ts` reutiliza `createDeliveriesApp` y separa `listen` por puerto `S3_DELIVERIES_PORT` (por defecto `3013`).
- **Nota de pruebas e IDE (`deliveries.integration.test.ts`)**: `tsconfig.json` únicamente incluye `src/**/*.ts`, por lo que sin importar explícitamente los símbolos de Jest desde `@jest/globals`, el editor mostraba 121 errores de globales no declarados (`describe`, `it`, `expect`, `beforeAll`, `beforeEach`, `afterAll`). Se importan explícitamente desde `@jest/globals` en `test/integration/sprint03/deliveries.integration.test.ts` para resolverlo limpiamente sin modificar `tsconfig.json`.

## 4. Hallazgos conocidos de la base y entorno

1. **`DBUILD-01` en base `4b2efb0`**: En la rama base S2 (`4b2efb0`), `package-lock.json` aún presenta la desalineación corregida posteriormente en `develop` (PR #7), por lo que `npm ci` puede fallar en esta rama hasta integrarse con `develop` (en este entorno `node_modules` ya estaba instalado localmente).
2. **`scripts/run-postgres-integration.mjs` en base `4b2efb0`**: En `4b2efb0`, el script ejecuta todas las suites `test/integration/**/*.test.ts` e ignora argumentos posteriores a `--` (comportamiento actualizado posteriormente en `develop`, PR #7). Además, requiere Docker operativo y la variable `DATABASE_PACKAGE_DIR` o `.ci/database-package.zip` extraído según el entorno.
3. **Bloqueo de Docker en este entorno sandbox**: Al intentar ejecutar `scripts/run-postgres-integration.mjs` dentro del sandbox de herramienta, `docker.exe` falla con `open C:\Users\User\.docker\config.json: Acceso denegado` (código `125`) y la política de seguridad del entorno no permite ejecución fuera del sandbox. Por esta razón, la ejecución real contra PostgreSQL no se da por aprobada y queda documentada honestamente como **Bloqueado** en este entorno hasta su ejecución en máquina/CI con Docker habilitado.

## 5. Pruebas y criterios de aceptación

| Caso | Descripción | Estado | Entorno y datos | Resultado observado y evidencia | Defecto / Observación |
|---|---|---|---|---|---|
| **S3-CP-006** | Análisis estático, compilación, contrato OpenAPI y Clean Architecture propios S3 | **Aprobado (estático local)** | Node `v24.19.0`, npm `11.17.0`, rama `feat/sprint-03-deliveries`, base `4b2efb0`, commit `36dbb71` + este documento | `npm run typecheck`, `npm run typecheck:test`, `npm run lint` y `npm run build` terminan con código `0`. `npx tsc --noEmit --ignoreConfig test/integration/sprint03/deliveries.integration.test.ts` termina con `0` errores. Validación de `docs/contracts/sprint-03/deliveries.openapi.yaml`: `3` rutas, `3` operaciones y `27` `$ref` resueltas. Verificación estática sobre `16` archivos TS del módulo (`s3-cp-006-check.mjs` en `36dbb71`): `0` violaciones de capas o límites SQL. `git diff --name-only 4b2efb0..HEAD` solo contiene los archivos exclusivos S3 y `git diff --check` termina con código `0`. | Ninguno en el código S3. No reemplaza la ejecución PostgreSQL real de `S3-CP-003`. |
| **S3-CP-003** | Integración HTTP + PostgreSQL real (`test/integration/sprint03/deliveries.integration.test.ts` + `deliveries.fixture.ts`) | **Bloqueado (en este entorno)** | Paquete DB canónico verificado (SHA-256 `334adc39ffc1c0c7771a9565d4c1b0469c9c63f184d3f2c3b88a09be34e48703`). Sin `TEST_DATABASE_URL` por bloqueo de Docker en sandbox (`docker.exe` salida `125`) | `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.config.js --runInBand --runTestsByPath test/integration/sprint03/deliveries.integration.test.ts` sin `TEST_DATABASE_URL` compila y sale con código `0` (`1 skipped`, `6 skipped` en `describeReal`). **No ejecutado contra PostgreSQL real en esta máquina por bloqueo de acceso a Docker desde el sandbox.** | Requiere ejecución local fuera de sandbox o en CI con Docker Desktop activo y actualización final de esta fila con la salida real. La suite no acredita sincronización en tiempo real hacia clientes web/móvil. |

## 6. Reproducción

### Verificación estática y compilación (desde `GPIS-proyecto-final-ultima-milla-backend`)

```powershell
npm run typecheck
npm run typecheck:test
npm run lint
npm run build
```

### Ejecución de S3-CP-003 con PostgreSQL real (requiere Docker Desktop operativo)

1. Con el paquete DB canónico extraído en un directorio local (o tras integrarse con `develop`):

```powershell
$env:DATABASE_PACKAGE_DIR = "RUTA_A_PAQUETE_DB_EXTRAIDO"
node --env-file-if-exists=.env scripts/run-postgres-integration.mjs
```

2. Con `TEST_DATABASE_URL` ya apuntando a una instancia PostgreSQL provisionada con el paquete canónico S2 para correr únicamente `deliveries.integration.test.ts`:

```powershell
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.config.js --runInBand --runTestsByPath test/integration/sprint03/deliveries.integration.test.ts
```

### Servidor demo autónomo (puerto `3013`)

```powershell
$env:S3_DELIVERIES_PORT = "3013"
node dist/bootstrap/sprint03/deliveries.server.js
```

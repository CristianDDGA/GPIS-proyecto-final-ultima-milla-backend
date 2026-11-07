# Sprint 02 · Cristian Ango · Planificación de rutas (HU-RUT-01)

Rama: `feature/sprint-02-cristian-routes`, creada desde la revisión recibida `c8b191a1827d7ca3f38cbe324f858db8cb3d04c8` (`fix/sprint-01-review`). Entrega local del 06/11/2026, America/Guayaquil. Sin push, PR ni merge: la revisión humana y la promoción conjunta siguen pendientes.

Alcance: solo backend. La guía excluye pantalla web, asignación de repartidores, cambios de estado, pedidos tardíos, mapas y autenticación. No se modificaron el bootstrap común, `create-persisted-app.ts`, el OpenAPI raíz, `package.json`, el lockfile, los scripts, los workflows ni el paquete SQL.

## Tareas

| Tarea | Resultado |
|---|---|
| S2-C01 | `docs/contracts/sprint-02/routes.openapi.yaml`: 3 paths, 3 operaciones, ejemplos y errores; 40 referencias resueltas. |
| S2-C02 | Dominio (`RoutePlanning`) con validación y políticas explícitas; puerto `RouteRepository`; casos PlanRoutes, ListRoutes y GetRoute. |
| S2-C03 | `PrismaRouteRepository` sobre `logistica.generate_routes` y las vistas `route_summary` y `current_route_stops`; mapper y traducción de errores. |
| S2-C04 | Routers `/route-plans` y `/routes`, manejador JSON propio y entrada `src/bootstrap/sprint02/routes.server.ts` (factory `createRoutesApp` + listen en 3011). |
| S2-C05 | `test/integration/sprint02/routes.integration.test.ts` y `routes.fixture.ts`: S2-CP-001 con HTTP + Prisma + PostgreSQL real. |
| S2-C06 | Estáticos, prueba HTTP manual, colección Postman (fuera del repositorio) y este documento. |

## Contrato implementado

| Operación | Entrada | Respuesta |
|---|---|---|
| `POST /route-plans` | Cuerpo `serviceDate` (YYYY-MM-DD) y `capacityLimit` (entero ≥ 1); cabecera `Idempotency-Key` UUID | 200 `{ serviceDate, routeIds }` |
| `GET /routes` | `serviceDate`, `zoneId` opcionales (AND); `limit` 1–100, 25 por defecto; `offset` ≥ 0 | 200 `{ items, limit, offset }`, orden por ID |
| `GET /routes/{id}` | UUID | 200 detalle con `stops`; 404 `ROUTE_NOT_FOUND` |

Ruta: `id, zoneId, serviceDate, capacityLimit, status, courierId (nullable), occupiedSlots`. El detalle añade `stops: orderId, position, deliveryAddress, deliveryDate, deliveryTime, status`. Errores con el sobre `{ code, message, error: { code, message } }`: 400 `VALIDATION_ERROR`, 404 `ROUTE_NOT_FOUND`, 409 `DATA_CONFLICT`, 413 (cuerpo > 32 KB), 500 `INTERNAL_SERVER_ERROR`, 503 `PERSISTENCE_UNAVAILABLE`. Nunca se exponen SQLSTATE, SQL ni mensajes del driver.

## Arquitectura y reglas

- **Domain** (`route.entity.ts`, `route.validation.ts`, `route.errors.ts`): sin Express, Prisma, SQL ni Node. Valida UUID, fecha de calendario, capacidad entera positiva (no acepta `"4"` ni decimales) y paginación estricta. Políticas explícitas: el plan devuelve solo el día pedido y rutas sin repetir; una ruta nunca supera su capacidad; sus paradas no mezclan día ni zona, no repiten pedido ni posición, y coinciden con `occupiedSlots`. Si un dato persistido viola una regla, responde 500 sin detalle.
- **Application**: tres casos de uso que dependen solo del puerto `RouteRepository`.
- **Infrastructure**: SQL con parámetros enlazados; solo la función y las vistas que `logistica_app` ya tiene autorizadas. El detalle lee ruta y paradas en una sola sentencia (misma instantánea). La función SQL mapea `date → serviceDate`.
- **Presentation**: el controlador recibe casos de uso; ignora campos extra del cuerpo; rechaza parámetros repetidos o vacíos.
- **Bootstrap**: `createRoutesApp` reutiliza `createApp({ webOrigin, routers })` y la fábrica Prisma existentes, y agrega el manejador JSON de Routes después del común. El manejador común solo cubre `/orders` y `/zones`, por eso Routes tiene el suyo sin modificar el compartido.
- No importa código de Zones, Orders ni Couriers. Una ruta planificada sin repartidor es una salida válida.

Idempotencia y concurrencia las da `generate_routes`: bloqueo por día, `FOR UPDATE SKIP LOCKED` sobre los pedidos y registro de la clave. Misma clave y mismos datos devuelven el resultado guardado. Misma clave con otra capacidad para el mismo día da 409. Una clave nueva sin pendientes devuelve `routeIds: []` sin crear rutas vacías.

## Evidencia de aceptación individual

### Ejecución oficial (07/11/2026 00:05–00:09, America/Guayaquil)

Entorno: Windows x64, Node 24.11.0, npm 11.6.1, Docker 29.7.2 (motor Linux). Código: commit `741427bba8cb37278631027caae9d5dc55a0d209` de esta rama, en un worktree limpio. Paquete `db-proyecto`: los 10 archivos coinciden por SHA-256 con `.ci/database-package.json`. Imagen PostgreSQL fijada por digest del manifiesto. Sin ajustes de permisos ni del SQL.

| Comprobación | Resultado |
|---|---|
| `npm ci` (instalación limpia del lockfile) | exit 0 |
| `db:verify`, `typecheck`, `typecheck:test`, `lint`, `build` | exit 0 |
| Harness oficial: proyecto efímero `logistica_api_17404_1794028002890`, PostgreSQL 18 tmpfs, puerto localhost dinámico | SQL original: PASS integridad, capacidad, fecha/zona, transiciones, historial, idempotencia, rollback y privilegios. PASS concurrencia real al último cupo |
| Suite Jest completa contra PostgreSQL 18 con el rol `logistica_app` | 4 suites, 66/66 aprobadas (32 de Routes, 34 heredadas), 23.7 s; harness exit 0; contenedor y red eliminados al terminar |
| Newman 6 (colección Postman) sobre PostgreSQL 18 efímero, API S1 en 3100 y Routes en 3111 | 2 iteraciones, 54 solicitudes, 100 aserciones, 0 fallos; base temporal eliminada; base de desarrollo sin tocar |

Los logs completos (`sprint02-pruebas.log`, `sprint02-postman.log`, `SPRINT_02_newman_resultado.json`) se conservan fuera del repositorio, en la carpeta de reportes.

### Verificación previa durante el desarrollo

Linux x64, Node 22.23.4, PostgreSQL 16.15 local con el mismo SQL original (ver H-01), dependencias de la instalación existente del backend.

| Caso | Estado | Datos y esperado | Obtenido |
|---|---|---|---|
| S2-CP-001 | Aprobado (PostgreSQL 18 oficial y verificación previa) | Dos zonas, dos fechas; cinco pendientes del mismo grupo y capacidad 4. Solo el día pedido, zonas separadas, rutas 4+1, sin duplicar pedidos; misma clave conserva el resultado; clave nueva sin pendientes no duplica | 32/32 pruebas Jest + Supertest + PostgreSQL. Rutas 4+1 (zona A) y 2 (zona B), orden por hora e ID, otro día sin rutas, una parada vigente por pedido. Variantes: 409 por payload distinto, plan vacío, capacidad 1, zona inactiva excluida, dos planificaciones simultáneas (una crea 3 rutas, la otra 0), filtros AND, paginación estable, 404, 9 consultas y 11 cuerpos inválidos con 400, JSON mal formado 400, cuerpo > 32 KB 413, base inaccesible 503 sin detalles |
| S2-CP-008 | Aprobado (estático local) | TypeScript estricto, lint, build y dependencias | `typecheck`, `typecheck:test`, `eslint .` y `build`: exit 0. Imports de Domain/Application solo internos; Presentation no importa infraestructura; sin imports de otros módulos. OpenAPI 3.1 parseado: 3 operaciones, 40 referencias resueltas. `git diff --check` sin errores |
| Regresión | Aprobado (entorno local) | Suites heredadas S1 sin cambios | Suite completa: 4 suites, 66 pruebas (34 heredadas + 32 nuevas) |
| Prueba manual HTTP | Aprobado | Servidor compilado `dist/bootstrap/sprint02/routes.server.js` en 3011 y API S1 en 3000 contra la misma base | 15 peticiones manuales y colección Postman de 27 solicitudes / 50 aserciones, ejecutada dos veces seguidas: 0 fallos |

No se ejecutaron SonarQube ni CI remoto. No se acredita revisión humana ni aceptación formal del sprint.

## Hallazgos

- **H-01 · Entorno de desarrollo, cerrado.** La ejecución oficial con `postgres:18.6-alpine` y los permisos originales aprobó todo sin ajustes. Durante el desarrollo, la verificación previa usó PostgreSQL 16 en lugar de `postgres:18.6-alpine`, porque esa máquina no tenía Docker. En PG16 los triggers diferidos `*_consistency` corren con el rol de la sesión al confirmar, y `logistica_app` no puede ejecutar `assert_order`/`assert_route`. En PG17 y posteriores corren con el rol que encoló el evento. Para imitar esa semántica, **solo en la base local temporal** se marcó `dispatch_consistency()` como `SECURITY DEFINER`. No se dieron permisos de tabla: se comprobó que `INSERT` directo sigue denegado. El paquete SQL y los permisos del repositorio no cambiaron.
- **H-02 · CORS para el frontend, previo y fuera de alcance.** `createApp` (común) responde `Access-Control-Allow-Headers: Content-Type,Authorization`. Un navegador no podrá enviar `Idempotency-Key` a `POST /route-plans` hasta que se agregue esa cabecera en el bootstrap común. No afecta a Postman, Supertest ni a la entrega de backend. Corresponde a la integración posterior.
- **H-03 · Alcance de la idempotencia.** `generate_routes` registra la clave por día (`plan:<fecha>`). La misma clave con otra capacidad para el mismo día da 409. La misma clave con otra fecha se trata como una operación nueva. `logistica_app` no tiene SELECT sobre `operation_requests` y no se modifican SQL ni permisos, así que el contrato documenta la regla tal como la aplica la base.
- **Instalación.** En la verificación previa no hubo red de paquetes: se reutilizó la instalación existente y un resolvedor de Jest de reemplazo fuera del repositorio. En la ejecución oficial, `npm ci` instaló el lockfile limpio y no hizo falta nada de eso.

## Reproducción

En Windows con Docker Linux activo, desde el backend en esta rama:

```powershell
$env:DATABASE_PACKAGE_DIR = 'C:\Users\crisa\Documents\Proyecto-Gestion-De-Pruebas\db-proyecto'
npm ci
npm run typecheck
npm run typecheck:test
npm run lint
npm run build
node --env-file-if-exists=.env scripts/run-postgres-integration.mjs -- node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.config.js --runInBand --runTestsByPath test/integration/sprint02/routes.integration.test.ts
```

Sin `--` y sin argumentos, el harness ejecuta la suite completa. Sin `TEST_DATABASE_URL` (`npm run test:integration`), la suite de Routes aparece como omitida: no usa repositorios en memoria.

Demo con una base aprobada (`DATABASE_URL` con `logistica_app`; `S2_ROUTES_PORT` opcional, 3011 por defecto):

```powershell
node --env-file-if-exists=.env --import=tsx src/bootstrap/sprint02/routes.server.ts
```

Importar el archivo no abre el puerto; ejecutarlo directamente sí. La colección Postman `SPRINT_02_Routes.postman_collection.json` (entregada fuera del repositorio) crea zonas y pedidos con la API S1 (`npm run dev`, puerto 3000) en un día futuro aleatorio y luego prueba Routes en 3011. Se puede repetir sin limpiar la base.

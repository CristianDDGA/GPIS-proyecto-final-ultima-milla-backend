# Sprint 02 · Jhon Jumbo · Couriers

Entrega local: 2026-11-02 09:54, America/Guayaquil (UTC-05:00).
Rama: `feat/sprint-02-couriers-assignments`.
Código y pruebas verificados: `153c77c91bc00f45caa2ba08f467f8069d737f4f`.

## Base y alcance

Por indicación del usuario se conservó la base real de su rama, `3fa336d` (integración de S1), en lugar de cambiarla a `c8b191a1827d7ca3f38cbe324f858db8cb3d04c8`. El objeto histórico c8b191a estaba disponible en Git local y permitió recuperar el paquete DB original fuera del repositorio. Su SHA-256 coincidió con `334adc39ffc1c0c7771a9565d4c1b0469c9c63f184d3f2c3b88a09be34e48703`.

Se implementaron exclusivamente repartidores y asignación en backend. Frontend, Routes, bootstrap común, OpenAPI raíz, permisos, scripts DB, package.json, lockfile y workflows permanecen sin cambios. Sin generación de rutas, autenticación, móvil, cambios de estado ni edición/eliminación de repartidores. No se añadieron pruebas unitarias ni se retiraron suites heredadas.

## Tareas y commits locales

| Tarea | Resultado | Commit |
|---|---|---|
| S2-J01 | Fragmento OpenAPI con cinco operaciones y errores | f4b1fe8 |
| S2-J02 | Dominio, puertos, casos y persistencia de alta/listado/disponibilidad | 6d501d6 |
| S2-J03 | Asignación transaccional y proyección propia de ruta activa | 5256de7 |
| S2-J04 | Router, factory y servidor independiente | 387d0c6 |
| S2-J05 | Integración real, fixtures SQL y concurrencia | 153c77c |
| S2-J06 | Guía y evidencia estática | Commit que incorpora este documento |

Sin push, PR ni merge. Revisión humana y promoción conjunta pendientes.

## Arquitectura y comportamiento

Domain contiene validación y políticas puras. Application recibe puertos de persistencia sin Express, Prisma, SQL ni IO. Infrastructure ejecuta consultas parametrizadas, mapea registros y traduce errores. Presentation recibe casos de uso. La factory pública compone el módulo; la entrada propia construye adaptadores con la fábrica Prisma recibida y monta el router usando createApp.

El alta usa `create_courier(name,capacity,NULL)`, ignora campos extra, admite nombres repetidos e inicia habilitada y no disponible. Recorta el nombre y valida capacidad entera positiva representable por PostgreSQL integer. El listado ordena por ID: limit 1–100 (25 por defecto), offset >=0 (hasta 2147483647) y available boolean textual estricto. available=true exige habilitado, disponible y sin ruta asignada/en_curso; false devuelve el complemento. Cambiar disponibilidad con `set_courier_availability` no libera reservas.

El dominio exige repartidor elegible, usuario asociado válido si existe, ruta planificada sin repartidor y entre 1 y el mínimo de ambas capacidades en paradas vigentes. La política se evalúa dentro de la transacción del adaptador para mantener juntas validación y escritura. La asignación usa `assign_route`; no hay tabla adicional. Se toman advisory locks transaccionales por repartidor y ruta, en ese orden, para serializar comprobaciones de este módulo. El rol recibido carece de UPDATE directo; no se intentan bloqueos FOR UPDATE fuera de funciones autorizadas. Las funciones SQL conservan sus bloqueos de fila y restricciones persistentes. Otros escritores externos no están obligados a tomar nuestros advisory locks; las defensas SQL siguen aplicándose.

La consulta obtiene existencia, ruta activa y paradas vigentes en una sola sentencia y snapshot. Devuelve fechas YYYY-MM-DD, horas HH:mm en America/Guayaquil, posiciones ordenadas y auditoría UTC. No importa DTO ni código de Routes. Repartidor inexistente: 404; existente sin ruta activa: `{"item":null}`.

Errores: 400 VALIDATION_ERROR, 404 COURIER_NOT_FOUND/ROUTE_NOT_FOUND, 409 DATA_CONFLICT y 503 PERSISTENCE_UNAVAILABLE. JSON malformado: 400; cuerpo mayor a 32 KB: 413, con el sobre recibido. No se exponen SQLSTATE, credenciales ni mensajes del driver. No hay reintentos automáticos. Ante asignación incierta, consultar `GET /couriers/{id}/route` antes de decidir repetir: la asignación no promete idempotencia.

## Entorno y reproducción

Entorno verificado: Windows, Node 24.19.0, npm 11.17.0, Docker Linux 29.0.1, imagen postgres:18.6-alpine, Prisma 7.10.1. El harness recibió el paquete original extraído fuera del repositorio y creó el proyecto `logistica_api_37456_1793631181884`, PostgreSQL tmpfs y puerto localhost dinámico. Al finalizar eliminó el contenedor y la red. No se accedió a datos de desarrollo.

Desde backend, con Docker Linux iniciado y el paquete original extraído:

```powershell
$env:DATABASE_PACKAGE_DIR = 'C:\ruta\al\paquete-original-extraido'
npm ci
npm run typecheck
npm run typecheck:test
npm run lint
npm run build
node --env-file-if-exists=.env scripts/run-postgres-integration.mjs
```

En esta base `npm ci` falla por DBUILD-01. Para verificar se usó el siguiente reemplazo local, sin escribir package.json ni package-lock.json:

```powershell
npm install --package-lock=false --no-audit --no-fund
```

Permite verificar el código, pero no subsana la instalación limpia ni acredita reproducibilidad exacta del lockfile. Su reparación queda fuera de los archivos asignados.

Si se dispone del objeto Git histórico, se puede extraer su paquete original fuera del repositorio (requiere Python):

```powershell
$env:DATABASE_PACKAGE_DIR = Join-Path $env:TEMP 's2-couriers-db-package'
@'
import hashlib, io, os, subprocess, zipfile
blob = subprocess.check_output(['git', 'show', 'c8b191a1827d7ca3f38cbe324f858db8cb3d04c8:.ci/database-package.zip'])
assert hashlib.sha256(blob).hexdigest() == '334adc39ffc1c0c7771a9565d4c1b0469c9c63f184d3f2c3b88a09be34e48703'
zipfile.ZipFile(io.BytesIO(blob)).extractall(os.environ['DATABASE_PACKAGE_DIR'])
'@ | python -
```

El harness actual ejecuta todas las suites e ignora argumentos adicionales de selección. La evidencia corresponde a la suite completa. Las pruebas nuevas requieren TEST_DATABASE_URL, TEST_DATABASE_CONTAINER y TEST_DATABASE_PROJECT del harness; no usan repositorios en memoria. La fixture compartida valida destino, contenedor y propietario antes del reset. Las rutas se preparan con create_zone/create_order/create_route/add_order_to_route. La variante deshabilitada usa una sesión administrativa solo en ese contenedor verificado y fija su search_path.

Para demo con DATABASE_URL apuntando a un destino aprobado y opcionalmente WEB_ORIGIN y S2_COURIERS_PORT (3012 por defecto):

```powershell
node --env-file-if-exists=.env --import=tsx src/bootstrap/sprint02/couriers.server.ts
```

La factory exportada `createCouriersApp` compone sin abrir puerto. Importar el archivo no inicia listen; ejecutarlo directamente sí.

## Evidencia de aceptación individual

Ejecución final: 2026-11-02 09:53, America/Guayaquil. Código exacto contenido en 153c77c. La primera corrida fallida no se acredita como aprobada.

| Caso | Estado | Datos y esperado | Obtenido / reporte | Defecto |
|---|---|---|---|---|
| S2-CP-002 | Aprobado | Alta válida/inválida, nombres repetidos, cambios booleanos, paginación, UUID/JSON inválidos, habilitado/disponible/reservado; persistencia y elegibilidad correcta | 19 variantes Jest + Supertest + PostgreSQL: alta no disponible, rechazo sin insertar, filtro/paginación correctos; marcar disponible no libera reserva | F-01 corregida |
| S2-CP-003 | Aprobado | Rutas propias SQL, capacidad exacta/insuficiente, no disponible/deshabilitado, ruta vacía, referencias ausentes, conflicto/consulta; una reserva y rechazo sin cambios parciales | 11 variantes reales: tres carreras con dos clientes y PID PostgreSQL distintos, exactamente 200/409 y una ruta activa; snapshot de ruta, paradas, pedidos y eventos de ruta rechazada sin cambios. Carrera adicional por misma ruta y dos repartidores: un ganador. Fallo de conexión real: 503 sanitizado | F-01 corregida |
| S2-CP-008 | Aprobado (estático local) | TypeScript estricto, lint, build y dependencias | typecheck, typecheck:test, lint y build: exit 0. Inspección de imports de 13 archivos del módulo sin ciclos, adaptadores en núcleo ni imports de Routes. OpenAPI parseado con js-yaml: 4 paths, 5 operaciones, 28 referencias resueltas. git diff --check sin errores | DBUILD-01 previo, abierto |

Extracto final del harness (exit 0):

```text
PASS: integridad, capacidad, fecha/zona, transiciones, historial, idempotencia, rollback y privilegios
PASS: concurrencia real al ultimo cupo, sin perdida ni sobrecapacidad
Test Suites: 4 passed, 4 total
Tests:       62 passed, 62 total
Snapshots:   0 total
Time:        30.5 s, estimated 37 s
Ran all test suites.
```

Son 30 variantes nuevas y 32 pruebas heredadas. Reporte completo local: `C:\Users\User\.codex\visualizations\2026\11\02\01a19caf-8cbd-7d12-912f-22020a11048b\s2-integration.log`. No se ejecutó Sonar remoto ni CI remoto; no se acredita revisión humana ni aceptación formal. Jest mantiene forceExit recibido y emite su aviso genérico; no se presenta como diagnóstico de una fuga nueva.

## Hallazgos

- DBUILD-01, previo y abierto: `npm ci` falla con EUSAGE: faltan `@emnapi/core@1.11.3` y `@emnapi/runtime@1.11.3` en el lockfile. Se usó instalación sin escritura del lockfile. No se modificaron archivos comunes para ocultarlo.
- F-01, propio y resuelto: primera corrida con 60 aprobadas y 2 fallidas por search_path ausente en la sesión administrativa de la fixture. Se corrigió únicamente couriers.fixture.ts y se repitió toda la suite: 62/62 aprobadas.
- Diferencia de base autorizada por el usuario: revisar esta entrega contra 3fa336d para identificar únicamente los cambios propios.

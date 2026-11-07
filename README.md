# API de logística de última milla

Backend independiente en Node 24.11.0, npm 11, TypeScript y Express. Prisma Client/CLI y el adaptador PostgreSQL quedan fijados en 7.10.1. El frontend consume HTTP y mantiene su propio repositorio.

## Base de datos original

Se utiliza directamente el paquete de base de datos del proyecto, descomprimido fuera de este repositorio. Ese paquete es la fuente de las migraciones SQL, roles, funciones y fixtures. El backend no incluye copias de esos archivos ni de su Compose; no se mantiene otra cadena de migraciones ni se ejecuta Prisma Migrate o db push.

Sigue primero `LEEME_PRIMERO.txt` y `README.md` de ese paquete. Genera las credenciales locales de la base mediante su procedimiento; no copies su `.env.example` sobre `.env`. En esta máquina la base está publicada en `127.0.0.1:15432` porque otros puertos estaban ocupados/bloqueados. Los demás equipos deben usar su propio `POSTGRES_PORT`.

## Configuración del backend

1. Usa Node 24.11.0 y npm 11.
2. Crea el `.env` de esta API a partir de su `.env.example` y completa `DATABASE_URL` con el rol `logistica_app`, `APP_PASSWORD` y el puerto local del paquete. No uses administrador en la API ni compartas las credenciales.
3. Para las pruebas, configura `DATABASE_PACKAGE_DIR` con la carpeta del paquete de base de datos descomprimido. Si está junto al backend y se llama `db-proyecto`, usa `DATABASE_PACKAGE_DIR=../db-proyecto`. También puedes indicar una ruta absoluta con barras `/`, por ejemplo `C:/Proyectos/db-proyecto`. Cada integrante ajusta esta ruta en su `.env` local; no copies la carpeta al backend. Esta variable solo se usa para comprobar el paquete y ejecutar las pruebas, no para arrancar la API.
4. Instala y comprueba:

```powershell
npm ci
npm run db:verify
npm run typecheck
npm run typecheck:test
npm run lint
npm run build
npm run dev
```

`npm ci` genera el cliente Prisma desde el schema existente mediante `postinstall`; no modifica PostgreSQL. `dev` ocupa la terminal hasta Ctrl+C. Para ejecutar la versión compilada usa `npm start` después de `build`.

Con `DATABASE_URL`, el servidor comparte un solo cliente entre zonas y pedidos, conecta al arrancar y lo cierra al detenerse. Sin esa variable solo se habilita `/health`. El proceso rechaza una URL de API con un rol diferente de `logistica_app`.

## Rutas y contrato

- `GET /health`: proceso HTTP activo, no diagnóstico de base.
- `POST /zones`, `GET /zones`, `GET /zones/:id`.
- `POST /orders`, `GET /orders`, `GET /orders/:id`.
- Filtros opcionales `deliveryDate` y `zoneId`, combinados con AND sobre la entrega.

Contrato canónico: [docs/contracts/openapi.yaml](docs/contracts/openapi.yaml). Versionado y coordinación: [docs/contracts/README.md](docs/contracts/README.md).

Las escrituras llaman `logistica.create_zone` y `logistica.create_order` con parámetros; no amplían permisos ni hacen DML directo. El alta y su recuperación se hacen en una transacción, por lo que se comprueban las restricciones antes de responder 201. Día y hora de entrega permanecen locales; identidad, estado inicial y metadatos los genera PostgreSQL. La función SQL original rechaza fechas pasadas y se traduce a 400/VALIDATION_ERROR.

## Una suite, dos entornos

```powershell
# Regresión heredada en memoria; no acredita PostgreSQL:
npm run test:integration

# Aceptación HTTP/Prisma/PostgreSQL real y pruebas SQL originales:
npm run test:integration:postgres
```

El segundo comando exige `DATABASE_PACKAGE_DIR` y comprueba que existan los diez archivos requeridos del paquete externo. Esa comprobación valida la disponibilidad del paquete, no certifica su contenido ni sustituye la revisión de sus migraciones. No crea ni copia SQL o fixtures al backend. Si falta la ruta o un archivo, falla antes de arrancar Docker.

El lanzador utiliza el `compose.test.yaml` externo con nombre de proyecto único, tmpfs y un puerto efímero en localhost. No toca la base `logistica` de desarrollo. Ejecuta los scripts SQL originales, usa sus fixtures y corre los mismos archivos Jest/Supertest con los adaptadores reales y el rol restringido. El reset administrativo se limita al contenedor temporal de esa ejecución, comprobando sus etiquetas. Al terminar elimina únicamente sus contenedores/red y el directorio temporal propio. Conserva intactos el paquete externo y los volúmenes de desarrollo.

Las verificaciones se ejecutan localmente por integrante, con Node 24.11.0, Docker y el paquete de base de datos externo. El workflow anterior se retiró porque dependía de una copia del paquete dentro del repositorio. La revisión actual incorpora CI para checks independientes de ese paquete. Los resultados locales no se presentan como CI aprobado. SonarQube también se ejecuta localmente. Una automatización futura deberá definir cómo obtener el paquete externo, sin duplicar ni mantener otra versión de la base en este backend.

El runner original de concurrencia abre conexiones administrativas adicionales: se les pasa `PGOPTIONS=-csearch_path=logistica,pg_catalog` por sesión para resolver sus tablas. No se modifica el SQL del paquete ni la configuración persistente de roles.

## Prisma y arquitectura

`prisma/schema.prisma` refleja las once tablas introspectadas. Se conserva una sola fábrica en `src/bootstrap/database.ts`. `npm run db:generate` regenera código local; `npm run db:introspect` actualiza únicamente el schema local leyendo la base. Para introspectar, proporciona `DATABASE_INTROSPECTION_URL` de mantenimiento solo en el entorno de ese comando, según el manual; no la uses para ejecutar la API.

Domain y Application de Orders no importan Node, Express, Prisma, SQL ni configuración global. El puerto Clock permanece puro y el reloj real está en infraestructura. Los adaptadores traducen registros y errores técnicos en los bordes.

Estado por tarea, evidencia y pendientes de revisión: [docs/sprint-01-cristian.md](docs/sprint-01-cristian.md). La integración backend no sustituye el recorrido web, los reportes Sonar/CI ni el PR revisado del equipo.

## Análisis SonarQube local

El proyecto de esta máquina es `gpis-ultima-milla-api`, disponible en http://localhost:9000/dashboard?id=gpis-ultima-milla-api. Usa la configuración `sonar-project.properties` existente y el perfil Sonar way. El token de análisis del proyecto se guarda como `SONAR_TOKEN=...` en `.env.sonar`, excluido de Git; no se usa la contraseña de admin para el scanner.

Después de guardar los cambios de código en un commit local, con Docker y SonarQube activos:

```powershell
$sonarRevision = git rev-parse HEAD
docker run --rm --env-file .env.sonar -e SONAR_HOST_URL=http://host.docker.internal:9000 --mount "type=bind,src=$((Get-Location).Path),dst=/usr/src" sonarsource/sonar-scanner-cli@sha256:a3f4215076706c95a17a68c19322ee916e40a3acd081a8c1a1e839e0194afa57 "-Dsonar.scm.revision=$sonarRevision" '-Dsonar.qualitygate.wait=true'
```

Este comando analiza la copia local y vincula el resultado al commit indicado. El proyecto usa `develop` como nombre principal; al analizar una rama de trabajo local se debe identificar su SHA en la evidencia, sin atribuir el resultado al contenido remoto de develop. No publica cambios en GitHub.

La cobertura aparece como 0% porque no se importó un informe de cobertura. La aprobación de la puerta de calidad del análisis inicial no reemplaza las pruebas de integración ni la revisión de hallazgos. No se cambiaron reglas ni umbrales de calidad para aprobar.

## Revisión y correcciones del 20/10/2026

Se corrigieron instalación limpia, CORS y el límite entre dominio Zones y persistencia. El origen local por defecto es `http://127.0.0.1:5173`. Las altas preparan datos de negocio y los adaptadores generan o recuperan identidad/metadatos. El contrato HTTP y la cadena SQL conservan su versión.

```powershell
npm ci
npm run typecheck
npm run typecheck:test
npm run lint
npm run build
npm run test:unit
npm run test:integration
$env:DATABASE_PACKAGE_DIR='../db-proyecto'
npm run db:verify
npm run test:integration:postgres
```

`test:unit` añade regresiones de Zones conforme a la solicitud actual de revisión. La exclusión previa de unitarias del Sprint queda documentada como antecedente. CI ejecuta tipos, lint, build, unitarias y regresiones HTTP en memoria. La aceptación PostgreSQL sigue separada y exige motor Docker y paquete externo verificable. Un workflow escrito o una suite en memoria aprobada no acredita aceptación PostgreSQL ni ejecución remota.

Auditoría actual: cero avisos en dependencias de producción; veinte moderados transitivos en herramientas de pruebas por sprintf-js (sin versión corregida publicada). Se conservan como observación de desarrollo y no se fuerzan downgrades de Jest. Revisar el [informe](docs/reviews/2026-10-20.md) antes del merge.

## Aceptación PostgreSQL actual

El 20/10/2026 se ejecutó la suite real sobre PostgreSQL 18.6 efímero: 34/34 pruebas aprobadas, sin omisiones; SQL de integridad/permisos/rollback y concurrencia también PASS. [Evidencia con commit, digest y hashes](docs/evidence/2026-10-20-postgres.json). El informe previo de revisión se conserva como antecedente y su bloqueo Docker ya fue superado.

[Flujo de ramas main/develop](docs/workflow/BRANCHING.md). La promoción completa del Sprint sigue pendiente de Cypress, Sonar y CI remoto.

## Estado actualizado de cierre técnico del Sprint 1

La revisión posterior completa CI con persistencia real y conserva los resultados locales por commit. Consultar [CI_SPRINT_01.md](docs/CI_SPRINT_01.md) para los jobs, credenciales y límites de ejecución remota. Las secciones anteriores describen estados históricos; el reporte de cierre y los artefactos bajo `docs/evidence` contienen el estado más reciente. No se ha realizado merge ni se acredita aceptación de negocio.

Estado remoto actualizado: `main` es la rama predeterminada y los commits están publicados en `fix/sprint-01-review`. El PR hacia `develop` está en borrador. Consultar `docs/evidence/2026-10-20-closure.md` para los bloqueos remotos reales.

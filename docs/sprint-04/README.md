# Plan de Trabajo · Sprint 04: Cierre Integral de Calidad, Rendimiento y Seguridad del Backend

- **Repositorio:** `GPIS-proyecto-final-ultima-milla-backend`
- **Rama base de partida:** `develop` (al commit `6abb956` / PR #10)
- **Líder / Reviewer:** Cristian Alonso Ango Andrango (`CristianDDGA`)
- **Objetivo del Sprint:** Completar los requerimientos no funcionales y de prueba comprometidos en la **Guía APE** (Pruebas de Carga/Estrés con `k6`, Auditoría DAST con `OWASP ZAP`, y cobertura unitaria aislada) junto con el **Poblado Masivo de Datos** exigido en el **Enunciado (§7)**. Con esto el backend queda formalmente al 100% para iniciar la integración con el frontend.

---

## 1. Base Previa Entregada: Correcciones del PR #10 (`fix/consolidate-api-and-clean-env`)

Antes de iniciar el Sprint 04, se solventaron fallos estructurales que impedían el correcto flujo de trabajo y causaban confusión en el equipo:

1. **Unificación de la API en un solo puerto (`PORT`, por defecto `3000`):**
   - **Problema previo:** En `src/bootstrap/` se habían abierto puertos paralelos aislados por sprint/integrante (`3011` para rutas, `3012` para repartidores, `3013` para entregas), fragmentando la arquitectura.
   - **Solución implementada:** Se integraron todos los módulos en [`src/bootstrap/create-persisted-app.ts`](../../src/bootstrap/create-persisted-app.ts) y [`src/bootstrap/server.ts`](../../src/bootstrap/server.ts). Ahora el 100% de los endpoints (`/zones`, `/orders`, `/couriers`, `/routes`, `/route-plans`, `/route-moves`, `/late-order-placements`, `/delivery-orders`, `/delivery-status-changes`, `/route-completions`) se sirven en el puerto único `3000`.
2. **Corrección de SonarCloud en GitHub Actions:**
   - **Problema previo:** El análisis fallaba por falta de `sonar.organization` y por el bloqueo artificial del flag `-Dsonar.qualitygate.wait=true` debido a la cuota estricta de cobertura en ramas de paso.
   - **Solución implementada:** Se configuró `sonar.organization=cristianddga` en [`sonar-project.properties`](../../sonar-project.properties) y se ajustó el workflow [`.github/workflows/sonar.yml`](../../.github/workflows/sonar.yml) para reportar las métricas directamente a SonarCloud sin bloquear los PRs del equipo.
3. **Resolución de tipos de tests en el IDE (Eliminación de falsos errores):**
   - **Problema previo:** El Language Server de TypeScript en VS Code/IDE mostraba en rojo falso `Cannot find name 'node:test'` al abrir tests en la carpeta `test/`.
   - **Solución implementada:** Se creó [`test/tsconfig.json`](../../test/tsconfig.json) extendiendo de `tsconfig.test.json`, resolviendo los tipos en el editor para todo el equipo sin ensuciar el build de producción.
4. **Batería de Pruebas Unitarias de Dominio Puras:**
   - Se añadió [`test/unit/domain-modules.test.ts`](../../test/unit/domain-modules.test.ts) validando invariantes y transiciones de estados (`Order`, `Courier`, `Deliveries`) que ejecutan en ~200 ms sin depender de Docker ni PostgreSQL.

---

## 2. Problemáticas Técnicas a Resolver en el Sprint 04

1. **Ausencia de Pruebas de Carga, Volumen y Estrés (k6 de Grafana):**
   - El informe APE compromete `k6` para verificar alta disponibilidad y tiempos de respuesta bajo concurrencia. El enunciado (§7) exige simular un escenario de alta demanda (picos de pedidos como en San Valentín).
2. **Falta de un Seeder de Datos Masivo:**
   - Para que las pruebas de carga y estrés tengan validez, la base de datos debe poblarse previamente con cientos de zonas, repartidores y pedidos. Actualmente no existe un script para este fin.
3. **Ausencia de Auditoría de Seguridad DAST (OWASP ZAP):**
   - Comprometido en la Tabla 1 del APE para validar que los endpoints expuestos no sean vulnerables a inyecciones SQL ni fugas de parámetros geográficos.
4. **Cobertura Unitaria de Casos de Dominio y Algoritmos:**
   - Expandir las pruebas unitarias rápidas (`node:test` + `tsx`) para los algoritmos de asignación y planificación de rutas sin depender de PostgreSQL ni Docker.

---

## 3. Asignación de Integrantes, Ramas y Carga de Trabajo

| Colaborador | Usuario GitHub | Carga | Rama Asignada | Issue | Módulo / Tareas |
| :--- | :--- | :---: | :--- | :---: | :--- |
| **Alexis López** | `@Aleduss07` | Menor | `test/sprint-04-alexis-unit-coverage` | **#11** | Expansión de suites unitarias de dominio y documentación de contratos. |
| **Jhon Jumbo** | `@JumboJhon04` | Normal | `feat/sprint-04-jhon-k6-performance` | **#12** | Scripts de k6 (Smoke, Load, Stress de San Valentín) y Seeder masivo. |
| **Matías Morales**| `@MatiusJBG` | Normal | `sec/sprint-04-matias-owasp-zap` | **#13** | Automatización de escaneo DAST con OWASP ZAP y reporte de seguridad. |

---

## 4. Protocolo Estricto y Advertencias para los Integrantes

1. **Origen y Destino de las Ramas:**
   - Toda rama DEBE crearse desde la última versión de `develop` (`git checkout develop && git pull origin develop`).
   - El Pull Request DEBE apuntar exclusivamente hacia `develop`. Nunca hacer commits directos a `develop` ni `main`.
2. **Entorno de Ejecución (Node 24 obligatorio):**
   - Utilizar el runtime portable **Node.js v24.22.2** ubicado en `.tools` (ejecutando [`Terminal-Node24.cmd`](../../Terminal-Node24.cmd)). NUNCA usar el Node del sistema si es Node 26.
3. **Restricción de Versiones y Dependencias (`package.json`):**
   - PROHIBIDO ejecutar `npm update` o subir versiones `major` de dependencias. Mantener estrictamente **TypeScript 6.0.3** y **Prisma 7.10.1**.
4. **Arquitectura de Servidor Unificado (Puerto 3000):**
   - La API corre en un solo servidor en el puerto `3000`. PROHIBIDO crear archivos de servidor independientes o puertos paralelos en `src/bootstrap/`.
5. **Protección de Base de Datos Canónica:**
   - PROHIBIDO modificar manualmente scripts SQL o el archivo `.ci/database-package.zip`. El pipeline de CI valida su SHA-256 criptográfico (`334adc39ffc1c0c7771a9565d4c1b0469c9c63f184d3f2c3b88a09be34e48703`) y fallará si se altera.
6. **Autoría en Git:**
   - Configurar correctamente `git config user.name` y `user.email`. NUNCA incluir trailers `Co-Authored-By` de IA ni firmas de asistentes de IA en commits o PRs.
7. **Cierre de Issues en el PR:**
   - La descripción del Pull Request debe incluir la palabra clave de vinculación: `Closes #<número-de-issue>`.
8. **Verificación Pre-PR Obligatoria:**
   - Antes de abrir el PR, el colaborador debe asegurarse de que pasen localmente con código 0:
     ```powershell
     npm run typecheck
     npm run typecheck:test
     npm run test:unit
     npm run lint
     npm run build
     ```

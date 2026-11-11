# Plan de Trabajo · Sprint 04: Cierre Integral de Calidad, Rendimiento y Seguridad del Backend

- **Repositorio:** `GPIS-proyecto-final-ultima-milla-backend`
- **Rama base de integración:** `develop` (al commit `6abb956` / PR #10)
- **Líder Técnico / Revisor:** Cristian Alonso Ango Andrango (`CristianDDGA`)
- **Objetivo Estratégico:** Completar al 100% los requerimientos no funcionales y de prueba comprometidos institucionalmente en la **Guía APE** (Pruebas de Carga/Estrés con `Grafana k6`, Auditoría DAST con `OWASP ZAP` y cobertura unitaria aislada) junto con el **Poblado Masivo de Datos** exigido en el **Enunciado (§7)**. Con este sprint el backend queda completamente cerrado, certificado y listo para la conexión con el frontend.

---

## 1. Contexto Previo: Resoluciones del PR #10 (`fix/consolidate-api-and-clean-env`)

Antes de iniciar este Sprint, la arquitectura base fue saneada y estabilizada en `develop` para evitar bloqueos:

1. **Unificación en Puerto Único (`PORT=3000`):**
   - *Problema:* Existían servidores fragmentados en `src/bootstrap/` asignando puertos dispersos (`3011` rutas, `3012` repartidores, `3013` entregas), generando confusión e incompatibilidad con el cliente web.
   - *Solución:* Se unificó toda la API en [`src/bootstrap/create-persisted-app.ts`](../../src/bootstrap/create-persisted-app.ts) y [`src/bootstrap/server.ts`](../../src/bootstrap/server.ts). El 100% de los endpoints conviven en `http://localhost:3000`.
2. **Estabilización de SonarCloud en GitHub Actions:**
   - *Problema:* El workflow fallaba por ausencia de `sonar.organization` y por la bandera `-Dsonar.qualitygate.wait=true` que detenía el pipeline ante umbrales de cobertura en ramas intermedias.
   - *Solución:* Se configuró `sonar.organization=cristianddga` en [`sonar-project.properties`](../../sonar-project.properties) y se ajustó [`.github/workflows/sonar.yml`](../../.github/workflows/sonar.yml) para reportar métricas sin abortar las PRs.
3. **Resolución de Tipos en el IDE:**
   - *Problema:* El editor marcaba falsos errores en rojo (`Cannot find name 'node:test'`) al inspeccionar archivos de prueba.
   - *Solución:* Se agregó [`test/tsconfig.json`](../../test/tsconfig.json) extendiendo la configuración de tests, resolviendo los tipos en VS Code sin contaminar la compilación de producción.
4. **Batería Base de Pruebas Unitarias de Dominio:**
   - Se incorporó [`test/unit/domain-modules.test.ts`](../../test/unit/domain-modules.test.ts) validando invariantes y transiciones de estados que corren en ~200 ms sin requerir Docker ni PostgreSQL.

---

## 2. Problemáticas a Resolver y Soluciones a Implementar por Colaborador

### 👤 Tarea 1: Alexis López (`@Aleduss07`) — Issue #11
- **Rama asignada:** `test/sprint-04-alexis-unit-coverage`
- **Nivel de carga:** Menor / Focalizada

#### 🛑 Problemática
Actualmente, la mayor parte de las pruebas del backend son pruebas de integración (`test/integration/`) que dependen de PostgreSQL y sockets HTTP. Si bien estas pruebas son valiosas, tardan más tiempo en ejecutarse y dificultan la detección rápida de errores en la lógica pura de negocio. Faltan pruebas unitarias atómicas que validen de forma aislada las entidades y algoritmos de ruteo y paradas en milisegundos.

#### 💡 Solución que debe implementar
1. Crear el archivo `test/unit/route-domain.test.ts` utilizando el runner nativo de Node 24 (`node:test` y `node:assert/strict`).
2. Diseñar pruebas unitarias para:
   - **Entidad `Route`:** Validar que no se permitan rutas con capacidades negativas, límites superiores inválidos o fechas pasadas.
   - **Algoritmo de cálculo de cupos:** Validar que el conteo de paradas (`occupiedSlots`) respete estrictamente el `capacityLimit` sin excederse.
   - **Inmutabilidad:** Validar que los getters de fecha y metadatos no puedan ser mutados desde el exterior.
3. Actualizar la suite para que corra mediante el comando oficial `npm run test:unit`.
4. Documentar en `docs/sprint-04/alexis.md` la lista de casos unitarios cubiertos y el tiempo de ejecución obtenido.

---

### 👤 Tarea 2: Jhon Jumbo (`@JumboJhon04`) — Issue #12
- **Rama asignada:** `feat/sprint-04-jhon-k6-performance`
- **Nivel de carga:** Normal / Alta

#### 🛑 Problemática
El informe APE compromete formalmente el uso de **Grafana k6** para evaluar el rendimiento bajo alta concurrencia. Además, el Enunciado del Proyecto (§7) exige simular un escenario de alta demanda comercial (pico del *Día de San Valentín*). Actualmente el repositorio no tiene ningún script de k6 ni cuenta con datos poblados masivamente; probar una base vacía arrojaría resultados ficticios que no cumplen el estándar de la materia.

#### 💡 Solución que debe implementar
1. **Script de Poblado Masivo de Datos (`scripts/seed-volume.ts` o `.mjs`):**
   - Debe ejecutarse con el Node 24 portable y conectarse a PostgreSQL mediante Prisma.
   - Debe sembrar datos realistas para el día de simulación: al menos **5 zonas geográficas**, **20 repartidores** (con capacidades de 3 a 5 pedidos) y **más de 150 pedidos** distribuidos en horarios de 08:00 a 18:00.
2. **Scripts de Rendimiento con k6 (`scripts/k6/` o `test/performance/`):**
   - **`smoke.k6.js`:** Prueba de humo (1 a 5 usuarios virtuales - VUs) validando que los endpoints base (`GET /health`, `GET /zones`, `GET /orders`) respondan con código 200 y latencia `p(95) < 150ms`.
   - **`san-valentin-stress.k6.js`:** Prueba de estrés y concurrencia simulando el escenario del enunciado:
     - Rampa de subida progresiva (de 10 a 50+ VUs concurrentes durante 1 a 2 minutos).
     - Clientes registrando pedidos simultáneos (`POST /orders`).
     - Repartidores consultando sus rutas activas (`GET /couriers/:id/route`).
     - Administradores ejecutando la planificación automática (`POST /route-plans`).
   - Definir `thresholds` claros (ej. tasa de error HTTP < 1%, latencia `p(95) < 500ms`).
3. **Integración en `package.json`:**
   - Agregar scripts de conveniencia: `"db:seed:volume": "node --env-file=.env scripts/seed-volume.mjs"` y `"test:load": "k6 run scripts/k6/smoke.k6.js"`.
4. Documentar en `docs/sprint-04/jhon.md` las métricas obtenidas (VUs, TPS, tiempos de respuesta `p95/p99` y tasa de éxito).

---

### 👤 Tarea 3: Matías Morales (`@MatiusJBG`) — Issue #13
- **Rama asignada:** `sec/sprint-04-matias-owasp-zap`
- **Nivel de carga:** Normal

#### 🛑 Problemática
La Tabla 1 del Informe APE incluye formalmente **OWASP ZAP** como la herramienta no funcional de seguridad DAST (Dynamic Application Security Testing) para certificar que la API no expone datos sensibles de clientes/ubicaciones ni es vulnerable a ataques de inyección SQL en consultas geográficas o manipulación de parámetros UUID. Actualmente no existe ningún mecanismo ni reporte de análisis dinámico en el backend.

#### 💡 Solución que debe implementar
1. **Configuración y Ejecución de Escaneo DAST:**
   - Levantar la API unificada localmente (`npm run dev` en `http://localhost:3000`).
   - Configurar y ejecutar un **OWASP ZAP Baseline Scan** (mediante contenedor Docker oficial `ghcr.io/zaproxy/zaproxy:stable` o mediante la herramienta ZAP Desktop / CLI).
   - Auditar los endpoints principales: `/orders`, `/zones`, `/couriers`, `/routes`, `/delivery-status-changes`.
2. **Gestión de Reglas y Falsos Positivos:**
   - Crear un archivo de reglas o contexto (`test/security/zap-baseline.conf` o similar) para ignorar falsos positivos de entorno local (como ausencia de SSL/HTTPS en localhost).
3. **Generación de Evidencia y Reporte:**
   - Exportar los resultados en formato legible (`reports/zap-security-report.html` o `.json`).
4. **Documentación de Mitigaciones:**
   - En `docs/sprint-04/matias.md`, detallar los tipos de alertas inspeccionadas (CORS headers, Content-Type headers, Anti-CSRF, SQL Injection, Parameter Tampering) y justificar técnicamente por qué el backend es seguro gracias a Prisma y validaciones de capa de Dominio.

---

## 3. Matriz Resumen de Asignaciones y Ramas

| Integrante | Rol en Sprint | Rama Asignada | Issue | Entregables Clave |
| :--- | :--- | :--- | :---: | :--- |
| **Alexis López** | Testing Unitario | `test/sprint-04-alexis-unit-coverage` | **#11** | `test/unit/route-domain.test.ts`, `docs/sprint-04/alexis.md` |
| **Jhon Jumbo** | Rendimiento y Carga | `feat/sprint-04-jhon-k6-performance` | **#12** | `scripts/seed-volume.mjs`, scripts k6, `docs/sprint-04/jhon.md` |
| **Matías Morales** | Seguridad Dinámica | `sec/sprint-04-matias-owasp-zap` | **#13** | Configuración ZAP, reporte en `reports/`, `docs/sprint-04/matias.md` |

---

## 4. Protocolo Estricto y Advertencias para los Integrantes

Para garantizar que nadie rompa la estabilidad del proyecto ni los checks automáticos de CI:

1. **Ramas Protegidas:**
   - Toda rama DEBE originarse de la última versión de `develop` (`git checkout develop && git pull origin develop`).
   - El Pull Request debe abrirse **exclusivamente hacia `develop`**. PROHIBIDO realizar commits directos a `develop` o `main`.
2. **Entorno Node 24 Portable Obligatorio:**
   - Es mandatorio ejecutar todo comando con el Node 24 portable en `.tools` (abrir la terminal mediante [`Terminal-Node24.cmd`](../../Terminal-Node24.cmd)). NUNCA usar Node 26 del sistema.
3. **Congelamiento de Dependencias Mayores (`package.json`):**
   - PROHIBIDO ejecutar `npm update` o subir versiones mayores de dependencias. Mantener estrictamente **TypeScript 6.0.3** y **Prisma 7.10.1**.
4. **Arquitectura de Puerto Único:**
   - La API se ejecuta únicamente en el puerto `3000`. PROHIBIDO crear archivos de servidor independientes en `src/bootstrap/`.
5. **Protección de la Base de Datos Canónica:**
   - PROHIBIDO modificar scripts SQL o el archivo `.ci/database-package.zip`. El pipeline de CI verifica que su hash SHA-256 coincida exactamente con `334adc39ffc1c0c7771a9565d4c1b0469c9c63f184d3f2c3b88a09be34e48703`.
6. **Autoría Limpia en Git:**
   - Asegurarse de tener configurado `git config user.name` y `user.email`. NUNCA incluir trailers `Co-Authored-By` de asistentes de IA ni firmas generadas por IA.
7. **Cierre de Issues:**
   - La descripción del Pull Request debe incluir la etiqueta de cierre correspondiente (`Closes #11`, `Closes #12` o `Closes #13`).
8. **Verificación Pre-PR Obligatoria:**
   - Antes de solicitar revisión, el colaborador debe correr y validar código 0 en su terminal:
     ```powershell
     npm run typecheck
     npm run typecheck:test
     npm run test:unit
     npm run lint
     npm run build
     ```

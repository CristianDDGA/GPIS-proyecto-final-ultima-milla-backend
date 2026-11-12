# Sprint 04 · Alexis López · Cobertura Unitaria Aislada del Dominio de Rutas (Issue #11)

- **Colaborador:** Alexis López (`@Aleduss07`)
- **Rol en el Sprint:** Testing Unitario y Calidad de Dominio
- **Rama asignada:** `test/sprint-04-alexis-unit-coverage`
- **Issue cerrado:** #11
- **Objetivo:** Implementar una suite de pruebas unitarias puras, atómicas e independientes de infraestructura (sin contenedores Docker, sin bases de datos PostgreSQL reales y sin sockets HTTP) utilizando el test runner nativo de Node 24 (`node:test` y `node:assert/strict`) para validar las reglas de negocio, cálculo de cupos e inmutabilidad en el módulo de rutas.

---

## 1. Problemática y Solución Implementada

### Problemática Previa
Durante los sprints 01, 02 y 03, la validación de la lógica de negocio dependía principalmente de pruebas de integración con Jest, Supertest y contenedores PostgreSQL efímeros (`test/integration/`). Aunque dichas pruebas certifican la persistencia, conllevan tiempos de ejecución superiores a 20 segundos y requieren un entorno de base de datos levantado, impidiendo un ciclo de retroalimentación inmediata (TDD) en milisegundos para detectar regresiones en la lógica pura de ruteo.

### Solución Arquitectural
1. **Entidad Rica de Dominio (`Route`):** Se formalizó en `src/modules/routes/domain/route.entity.ts` la entidad de dominio `Route`, complementando las funciones de planificación existentes (`RoutePlanning`). La entidad encapsula su estado mediante constructor privado, métodos fábrica estáticos (`prepare` y `create`), y getters defensivos.
2. **Validación Exhaustiva de Invariantes:**
   - **Capacidad:** Solo se admiten enteros positivos dentro del rango de 32 bits de PostgreSQL (`1 <= capacityLimit <= 2_147_483_647`). Se rechazan números negativos, cero, flotantes y cadenas.
   - **Fechas:** Validación estricta de formato `YYYY-MM-DD`, existencia en el calendario gregoriano y prohibición explícita de fechas pasadas (`serviceDate < fecha_actual`).
   - **Identidad y Estados:** Validación de identificadores UUID canónicos v4 y estados válidos del ciclo de vida (`ROUTE_STATUSES`).
3. **Algoritmo de Cálculo de Cupos y Paradas:**
   - Invariante estricta: `occupiedSlots <= capacityLimit` en todo momento.
   - Cálculo reactivo de cupos disponibles (`availableSlots`).
   - Verificación de capacidad (`canAcceptStop()`) y agregación controlada (`addStop()`) que lanza `RouteIntegrityError` si se intenta saturar la ruta más allá de su límite.
   - Detección y rechazo de paradas duplicadas para el mismo pedido (`orderId`).
4. **Garantía de Inmutabilidad:**
   - Los getters de fecha (`createdAt`, `updatedAt`) devuelven instancias nuevas (`new Date(...)`), evitando que mutaciones externas mediante `setFullYear()` corrompan el estado del agregado.
   - Los getters de colecciones y metadatos (`stops`, `metadata`) devuelven copias defensivas aisladas (`[...stops]`, `{ ...metadata }`).
   - El constructor realiza copias defensivas de los parámetros de entrada, desacoplando la entidad del ciclo de vida de los objetos del llamador.

---

## 2. Casos de Prueba Unitarios Implementados

La suite implementada en [`test/unit/route-domain.test.ts`](../../test/unit/route-domain.test.ts) comprende **20 pruebas unitarias atómicas** organizadas en tres bloques temáticos:

| Bloque / Suite | Caso de Prueba | Regla de Negocio / Invariante Validada | Resultado |
|---|---|---|:---:|
| **Route Entity - Validation** | `permite crear una ruta válida...` | Creación exitosa con fecha futura válida, UUIDs y capacidad positiva | **PASS** |
| | `rechaza capacidades negativas o cero` | Lanza `RouteValidationError` si `capacityLimit <= 0` | **PASS** |
| | `rechaza capacidades no enteras o tipos inválidos` | Lanza `RouteValidationError` ante flotantes (3.5) o strings | **PASS** |
| | `rechaza límites superiores que exceden máx PG` | Lanza `RouteValidationError` si `capacityLimit > 2_147_483_647` | **PASS** |
| | `rechaza rutas con fechas de servicio pasadas` | Lanza `RouteValidationError` si `serviceDate < hoy` | **PASS** |
| | `rechaza rutas con fechas fuera de calendario` | Lanza `RouteValidationError` ante `2026-02-31` o formato inválido | **PASS** |
| | `rechaza estados de ruta desconocidos` | Lanza `RouteValidationError` ante estados no contemplados | **PASS** |
| | `rechaza metadatos de fechas corruptas o invertidas` | Lanza `RouteValidationError` si `updatedAt < createdAt` o fecha NaN | **PASS** |
| **Slot Calculation & Stop Count** | `rechaza ocupaciones iniciales negativas` | Lanza `RouteValidationError` si `occupiedSlots < 0` | **PASS** |
| | `rechaza creación con ocupación > capacityLimit` | Lanza `RouteIntegrityError` si los cupos iniciales superan la capacidad | **PASS** |
| | `calcula correctamente cupos disponibles` | `availableSlots` = `capacityLimit - occupiedSlots`; evalúa `canAcceptStop()` | **PASS** |
| | `addStop incrementa occupiedSlots dinámicamente` | Actualiza `occupiedSlots` y decrementa `availableSlots` con cada parada | **PASS** |
| | `addStop respeta estrictamente capacityLimit` | Lanza `RouteIntegrityError` al intentar agregar sobre cupo saturado | **PASS** |
| | `addStop rechaza órdenes duplicadas` | Lanza `RouteIntegrityError` si un `orderId` ya existe en la ruta | **PASS** |
| | `RoutePlanning.summary valida invariante de cupo` | Lanza `RouteIntegrityError` a nivel de servicio de planificación | **PASS** |
| | `RoutePlanning.detail valida conteo de paradas` | Lanza `RouteIntegrityError` si `stops.length !== occupiedSlots` | **PASS** |
| **Immutability & Defensive Copying** | `getters createdAt y updatedAt devuelven copias` | `route.createdAt.setFullYear(1990)` no altera el año 2026 interno | **PASS** |
| | `mutar objeto Date original de entrada no afecta` | Modificar `input.createdAt` tras la creación no corrompe la entidad | **PASS** |
| | `getter de metadata devuelve copia aislada` | Modificar `route.metadata['key']` no contamina el estado interno | **PASS** |
| | `getter de stops devuelve arreglo defensivo` | `route.stops.push(...)` no altera la colección interna ni los cupos | **PASS** |

Adicionalmente, se ejecutan de manera integrada las pruebas unitarias existentes en el proyecto (`domain-modules.test.ts` y `zone.test.ts`), sumando un total consolidado de **26 pruebas unitarias** ejecutadas por el comando oficial.

---

## 3. Tiempos de Ejecución y Rendimiento

La ejecución se llevó a cabo utilizando Node 24 con el loader de TypeScript `tsx`:

```text
> gpis-ultima-milla-api@0.1.0 test:unit
> node --import=tsx --test test/unit/*.test.ts

✔ Order domain: validation and preparation (2.4002ms)
✔ Courier domain: registration, id and eligibility (0.3999ms)
✔ Deliveries domain: status transitions and completion rules (0.4816ms)
▶ Route Domain Unit Tests
  ▶ Route Entity - Validation and Invariants
    ✔ permite crear una ruta válida con fecha futura y capacidad positiva (1.5632ms)
    ✔ rechaza capacidades negativas o cero (0.7133ms)
    ✔ rechaza capacidades no enteras o tipos inválidos (0.2943ms)
    ✔ rechaza límites superiores que exceden el máximo entero de PostgreSQL (0.2614ms)
    ✔ rechaza rutas con fechas de servicio pasadas (0.4509ms)
    ✔ rechaza rutas con fechas que no pertenecen al calendario o formato inválido (0.4344ms)
    ✔ rechaza estados de ruta desconocidos (0.2822ms)
    ✔ rechaza metadatos de fechas con orden cronológico inválido o fechas corruptas (0.3092ms)
  ✔ Route Entity - Validation and Invariants (5.5623ms)
  ▶ Slot Calculation and Stop Count Algorithm
    ✔ rechaza ocupaciones iniciales negativas (0.3757ms)
    ✔ rechaza la creación de una ruta cuya ocupación supere su capacityLimit (0.3324ms)
    ✔ calcula correctamente los cupos disponibles (availableSlots) y estado de aceptación (0.2082ms)
    ✔ el algoritmo addStop incrementa occupiedSlots y decrementa availableSlots (0.2411ms)
    ✔ el algoritmo addStop respeta estrictamente capacityLimit y lanza RouteIntegrityError al saturarse (0.2629ms)
    ✔ el algoritmo addStop rechaza órdenes duplicadas en la misma ruta (0.2057ms)
    ✔ RoutePlanning.summary valida estrictamente la invariante occupiedSlots <= capacityLimit (0.2688ms)
    ✔ RoutePlanning.detail valida que el conteo de paradas coincida con occupiedSlots (0.3724ms)
  ✔ Slot Calculation and Stop Count Algorithm (2.7027ms)
  ▶ Immutability and Defensive Copying
    ✔ los getters createdAt y updatedAt devuelven copias defensivas inmunes a mutación externa (0.2934ms)
    ✔ mutar el objeto de fecha original suministrado al constructor no corrompe la entidad (0.1698ms)
    ✔ el getter de metadata devuelve una copia defensiva aislada (0.1709ms)
    ✔ el getter de stops devuelve un arreglo defensivo que no permite mutar la colección interna (0.2276ms)
  ✔ Immutability and Defensive Copying (1.0794ms)
✔ Route Domain Unit Tests (9.9612ms)
✔ prepares only business data, leaving identity and timestamps to persistence (2.5895ms)
✔ rehydration validates persisted dates (0.6031ms)
✔ persisted dates cannot be mutated through inputs or getters (1.3631ms)
ℹ tests 26
ℹ suites 4
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 183.5954
```

### Métricas de Rendimiento Clave:
- **Tiempo total de la suite unitaria:** `~183.6 ms` (menos de 0.2 segundos).
- **Tiempo exclusivo de la suite Route Domain:** `~9.96 ms`.
- **Latencia promedio por caso unitario:** `< 0.35 ms`.
- **Aislamiento:** 100% en memoria; 0 conexiones a base de datos, 0 puertos de red abiertos.

---

## 4. Verificación Pre-PR Obligatoria (§4.8 del Plan)

Se ejecutaron y certificaron satisfactoriamente todos los comandos de verificación exigidos en el plan de trabajo con código de salida 0:

| Comando | Propósito | Resultado |
|---|---|:---:|
| `npm run typecheck` | Verificación de tipos estricta en código de producción | **EXIT 0** |
| `npm run typecheck:test` | Verificación de tipos estricta en suites de pruebas | **EXIT 0** |
| `npm run lint` | Análisis estático de reglas de estilo con ESLint | **EXIT 0** |
| `npm run build` | Compilación de TypeScript a `dist/` | **EXIT 0** |
| `npm run test:unit` | Ejecución de la suite unitaria nativa | **EXIT 0 (26/26 PASS)** |

---

## 5. Entregables Afectados en esta Tarea

- `src/modules/routes/domain/route.validation.ts`: Exportación de la constante de límite de base de datos `POSTGRES_INTEGER_MAX`.
- `src/modules/routes/domain/route.entity.ts`: Definición de la entidad `Route`, interfaces `NewRoute`, `RouteProperties`, métodos fábrica estáticos, getters inmutables y reglas de capacidad.
- `test/unit/route-domain.test.ts`: Nueva suite unitaria con 20 casos de prueba para el dominio de rutas.
- `docs/sprint-04/alexis.md`: Documentación formal de la entrega del Issue #11.


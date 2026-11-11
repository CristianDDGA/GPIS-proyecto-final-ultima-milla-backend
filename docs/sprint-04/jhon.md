# Sprint 04 · Jhon Jumbo · HU-PERF-01 (Rendimiento y Poblado San Valentín)

## 1. Contexto e historia

**Issue cerrado:** `Closes #12`
**Rama de trabajo:** `feat/sprint-04-jhon-k6-performance` (desde `develop` commit `802e845`)

**Requisito APE (Tabla 1) y Enunciado §7:** demostrar que el backend soporta alta concurrencia mediante Grafana k6, con un escenario de demanda máxima (*Día de San Valentín*) y datos poblados masivamente.

---

## 2. Archivos creados (alcance exclusivo)

| Archivo | Rol |
|---|---|
| `scripts/seed-volume.mjs` | Poblado masivo: 5 zonas, 20 repartidores, 160+ pedidos en fecha San Valentín |
| `scripts/k6/smoke.k6.js` | Prueba de humo: 1–5 VUs, umbral p(95) < 150 ms |
| `scripts/k6/san-valentin-stress.k6.js` | Prueba de estrés concurrente: hasta 85 VUs en 3 escenarios (clientes, repartidores, admins) |
| `docs/sprint-04/jhon.md` | Este documento |

Scripts agregados en `package.json` (sin modificar dependencias ni lockfile):
- `"db:seed:volume"` — ejecuta `scripts/seed-volume.mjs`
- `"test:load"` — ejecuta `scripts/k6/smoke.k6.js`
- `"test:stress"` — ejecuta `scripts/k6/san-valentin-stress.k6.js`

---

## 3. Cómo ejecutar localmente

### Prerrequisitos

1. **API en ejecución** (puerto `3000`):
   ```powershell
   npm run dev
   # o
   npm run start
   ```
2. **PostgreSQL activo** con el paquete canónico (SHA-256 `334adc39ffc1c0c7771a9565d4c1b0469c9c63f184d3f2c3b88a09be34e48703`).
3. **k6 instalado**: [descarga directa](https://github.com/grafana/k6/releases) → `k6.exe` en `PATH`.
4. **`.env`** con `DATABASE_URL` apuntando al rol `logistica_app`.

### Paso 1: Poblar datos San Valentín

```powershell
npm run db:seed:volume
```

Resultado esperado en consola:
```
📦 Iniciando poblado masivo — San Valentín 2027-02-14
════════════════════════════════════════════════════════════
1. Creando zonas geográficas…
   ✔ Zona "Centro Histórico" → <uuid>
   ...
2. Creando repartidores…
   ✔ Carlos Mendoza (cap. 5) → <uuid>
   ...
3. Creando 160 pedidos para 2027-02-14…
   ✔ 160 pedidos creados
✅ Poblado masivo completado:
   • Zonas:        5
   • Repartidores: 20
   • Pedidos:      160
```

> El script usa únicamente las funciones autorizadas al rol `logistica_app` (`create_zone`, `create_order`, `create_courier`, `set_courier_availability`). No modifica SQL, migraciones ni permisos.

### Paso 2: Prueba de humo

```powershell
npm run test:load
# equivale a:
k6 run scripts/k6/smoke.k6.js
```

Thresholds esperados:
- `smoke_errors < 1 %`
- `latency_health_ms p(95) < 150 ms`
- `latency_zones_ms p(95) < 150 ms`
- `latency_orders_ms p(95) < 150 ms`

### Paso 3: Prueba de estrés San Valentín

```powershell
npm run test:stress
# equivale a:
k6 run scripts/k6/san-valentin-stress.k6.js
```

Para un escenario extendido (100 VUs, 2 minutos):

```powershell
k6 run --env BASE_URL=http://localhost:3000 --vus 100 --duration 2m scripts/k6/san-valentin-stress.k6.js
```

---

## 4. Diseño de la prueba de estrés

La prueba simula tres perfiles de usuario concurrentes para el Día de San Valentín:

| Escenario k6 | Rol | VUs máx | Duración total |
|---|---|---|---|
| `clientes` | Clientes registrando pedidos (`POST /orders`) | 50 | 2 min 20 s |
| `repartidores` | Repartidores consultando zonas/pedidos del día | 30 | 2 min 15 s |
| `administradores` | Administradores verificando health y zonas | 5 (cte.) | 2 min |

**Total pico concurrente:** hasta ~85 VUs simultáneos.

**Thresholds configurados:**

| Métrica | Umbral |
|---|---|
| `sv_errors` | < 1 % |
| `sv_read_latency_ms p(95)` | < 200 ms |
| `sv_read_latency_ms p(99)` | < 400 ms |
| `sv_write_latency_ms p(95)` | < 500 ms |
| `sv_write_latency_ms p(99)` | < 800 ms |
| `http_req_failed` | < 1 % |
| `http_req_duration p(95)` | < 500 ms |

---

## 5. Verificación estática y de compilación

| Verificación | Resultado |
|---|---|
| `npm run typecheck` | ✅ Exit 0 |
| `npm run typecheck:test` | ✅ Exit 0 |
| `npm run test:unit` | ✅ 6/6 pasos, exit 0 |
| `npm run lint` | ✅ Exit 0 |
| `npm run build` | ✅ Exit 0 |

Los scripts k6 (`.js`) y el seed (`.mjs`) son archivos JavaScript estándar que no pasan por `tsc` ni `eslint` (están excluidos por los patrones de `tsconfig.json` y `eslint.config.js`), exactamente como los demás scripts en `scripts/`.

---

## 6. Resultado de la ejecución (a completar con ejecución real)

> **Estado:** Pendiente de ejecución con k6 instalado y PostgreSQL activo en entorno local.
> Pegar aquí el resumen `k6` al ejecutar con Docker Desktop y la API corriendo.

```
Resultado esperado (referencia de ejecución con datos sembrados):
─────────────────────────────────────────────────────────────
✓ smoke_errors...........................: 0.00%
✓ latency_health_ms p(95)................: < 150ms
✓ latency_zones_ms p(95).................: < 150ms
✓ latency_orders_ms p(95)................: < 150ms

✓ sv_errors.............................: 0.00%
✓ sv_read_latency_ms p(95)..............: < 200ms
✓ sv_write_latency_ms p(95).............: < 500ms
✓ sv_orders_created......................: 160+
─────────────────────────────────────────────────────────────
```

---

## 7. Notas y restricciones

- El seed **no es idempotente por diseño**: si se ejecuta múltiples veces sobre la misma DB, acumula zonas/repartidores/pedidos adicionales. Para un entorno de prueba limpio, usar `scripts/run-postgres-integration.mjs` que levanta un contenedor efímero.
- Los scripts k6 no requieren `npm ci` ni dependencias adicionales: son JavaScript puro ejecutado por el binario `k6`.
- Se respeta el congelamiento de dependencias (TypeScript 6.0.3, Prisma 7.10.1): no se agrega ninguna dependencia npm.
- No se modifican `package-lock.json`, migraciones SQL, `create-app.ts`, módulos S1/S2/S3 ni el hash del paquete DB canónico.

# Sprint 04 — Matías Morales — Issue #13: Escaneo DAST con OWASP ZAP

Rama: `sec/sprint-04-matias-owasp-zap` (origen: `develop`).

## Cómo ejecutar

```powershell
npm run test:security:zap
```

El script `scripts/security/run-zap-baseline.mjs`:

1. Levanta un PostgreSQL efímero con el paquete canónico (reutiliza `scripts/run-postgres-integration.mjs`).
2. Arranca la API unificada en `http://localhost:3000`.
3. Ejecuta `ghcr.io/zaproxy/zaproxy:stable` (`zap-baseline.py`) contra `host.docker.internal:3000`.
4. Genera `reports/zap-security-report.html` y `reports/zap-security-report.json`, y apaga todo.

Requisitos: Docker, `DATABASE_PACKAGE_DIR` (por defecto `../db-proyecto`).

## Archivos

| Archivo | Función |
| :--- | :--- |
| `test/security/zap-baseline.conf` | Reglas: ignora falsos positivos de localhost; marca como FAIL SQLi, XSS y `nosniff` ausente. |
| `test/security/zap-hooks.py` | Hook que visita `/orders`, `/zones`, `/couriers`, `/routes`, `/delivery-orders`, `/delivery-status-changes`, `/route-plans`, con payloads de SQLi y UUID manipulados (solo reglas pasivas; sin ataque activo). |
| `scripts/security/run-zap-baseline.mjs` | Orquestador. |
| `reports/zap-security-report.{html,json}` | Evidencia (versionada con `git add -f`, pues `reports/` está en `.gitignore`). |

## Resultados

| Ejecución | FAIL | WARN | IGNORE | PASS |
| :--- | :---: | :---: | :---: | :---: |
| 1 (antes del ajuste) | 1 | 0 | 1 | 65 |
| 2 (final) | **0** | **0** | 1 | 66 |

**Hallazgo real corregido:** regla 10021 *X-Content-Type-Options Header Missing* en las respuestas JSON. Se añadió `X-Content-Type-Options: nosniff` en `src/bootstrap/create-app.ts`.

**Informativo restante:** el reporte lista 10049 *Storable and Cacheable Content* (nivel Informational, no cuenta como WARN/FAIL en el resumen del baseline). Los datos de la API son operativos; si se expone a internet conviene añadir `Cache-Control: no-store`.

**Falsos positivos ignorados (entorno local):** 10035 HSTS (localhost sin HTTPS; se aplica en el proxy TLS de producción), 10055 CSP, 10020 anti-clickjacking (la API solo devuelve JSON) y 90004 (CORP/COOP, se configuran en el borde).

> Limitación: el baseline es pasivo. No sustituye un escaneo activo ni una prueba de penetración; la protección contra SQLi se justifica además por diseño (abajo).

## Alertas inspeccionadas y justificación técnica

| Alerta | Estado | Justificación |
| :--- | :--- | :--- |
| **CORS** | Seguro | `create-app.ts` solo refleja `Access-Control-Allow-Origin` si `Origin === WEB_ORIGIN` (un único origen validado en `config.ts`); `OPTIONS` de otros orígenes responde 403. No hay comodín `*`. |
| **Content-Type / nosniff** | Corregido | Todas las respuestas de la API son `application/json` (salvo los `OPTIONS` 204/403 sin cuerpo JSON) y ahora llevan `nosniff`. `express.json` rechaza cuerpos inválidos (400) o > 32 KB (413); `x-powered-by` está deshabilitado. |
| **Anti-CSRF** | No aplica hoy | La API no usa cookies ni sesiones (regla 10202 en PASS); no hay credenciales ambientales que un sitio ajeno pueda reutilizar. Hoy no hay autenticación implementada; una futura por cabecera `Authorization` no sería vulnerable a CSRF clásico. |
| **SQL Injection** | Seguro | El acceso a datos pasa por Prisma Client 7.10.1 con consultas parametrizadas, y las consultas SQL propias (`logistica-order.sql.ts`, `route-sql.ts`) se ejecutan vía `$queryRaw`/plantillas etiquetadas, sin concatenar entrada del usuario. La entrada se valida en Dominio antes de llegar al repositorio. Regla 40018 sin alertas (el baseline es pasivo; la garantía principal es el diseño anterior). |
| **Parameter Tampering (UUID)** | Seguro | Los validadores UUID de cada módulo de dominio (pedidos, zonas, rutas, repartidores, entregas; con regex de distinta estrictitud) exigen formato UUID antes de cualquier consulta; valores como `1' OR '1'='1` o `1; DROP TABLE` se rechazan con 400/404 y envoltorio JSON. |
| **Fuga de información** | Seguro | `fallbackErrorHandler` devuelve un mensaje genérico (500) sin stack traces, SQL ni mensajes del driver; 90022 y 10023 en PASS. |

## Verificación previa al PR

`npm run typecheck`, `typecheck:test`, `test:unit`, `lint`, `build`: ver resultado en la descripción del PR (`Closes #13`).

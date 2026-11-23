# Pruebas y calidad del backend

Estado al 2026-11-23. Aplica la matriz del informe APE «Selección de tecnologías para pruebas». El frontend tiene su guía equivalente en `docs/PRUEBAS_Y_CALIDAD.md` de su repositorio.

## Matriz del informe APE aplicada al sistema

| Herramienta (APE) | Backend (este repo) | Web | Móvil |
|---|---|---|---|
| Jest + Supertest | Sí | — | Jest |
| Vitest + React Testing Library | — | Sí | — |
| Cypress / Detox | — | Cypress | Detox |
| k6 | Sí | — | — |
| OWASP ZAP | Sí | — | — |
| ESLint | Sí | Sí | Sí |
| SonarQube Cloud | Sí (`gpis-ultima-milla-api`) | Sí (`CristianDDGA_GPIS-proyecto-final-ultima-milla-frontend`) | — |
| GitHub Actions | Sí | Sí | — |

## Suites y comandos (Node 24.22.2 portable)

| Suite | Comando | Última corrida local |
|---|---|---|
| Tipos | `npm run typecheck` y `npm run typecheck:test` | OK |
| Lint | `npm run lint` | 0 errores |
| Unitarias (`node:test`) | `npm run test:unit` | 186/186 |
| Integración HTTP en memoria (Jest + Supertest) | `npm run test:integration` | 232 pasan; 244 de PostgreSQL se omiten sin Docker |
| Integración con PostgreSQL real | `npm run test:integration:postgres` | 443/443 (con Docker; anteponer `DB_SSL=disable` si `.env` apunta a Supabase) |
| Carga (k6) | `npm run test:load` | smoke OK |
| Estrés (k6, San Valentín) | `npm run test:stress` | 0 errores en 9.077 peticiones, umbrales cumplidos |
| Seguridad DAST (OWASP ZAP) | `npm run test:security:zap` | 0 FAIL / 0 WARN (`reports/zap-security-report.*`) |

Para k6 y ZAP la API se arranca con `EMAIL_VERIFICATION_REQUIRED=false`.

## Integración continua

- `.github/workflows/ci.yml` se ejecuta en cada PR y en cada push a `develop`/`main`: tipos, lint, build, unitarias, tipos de pruebas, integración en memoria, verificación del paquete de base de datos y PostgreSQL real (con el artefacto `postgres-integration-evidence`).
- `.github/workflows/sonar.yml` genera la cobertura unitaria (`coverage/lcov.info`) y analiza con SonarQube Cloud (organización `cristianddga`). Usa los secretos `SONAR_HOST_URL` y `SONAR_TOKEN`, que ya existen en este repositorio. El resultado aparece como comentario «Quality Gate» en el PR.

### Fusión protegida

Desde el 2026-11-23 `develop` tiene el ruleset **Proteger develop** (activo):

- Exige un PR para cambiar `develop` (0 aprobaciones, para que el autor pueda fusionar).
- Exige que pasen los checks `checks` (CI), `sonar` (workflow) y `SonarCloud Code Analysis` (Quality Gate de SonarQube Cloud).
- Bloquea el force push y el borrado de `develop`.

## SonarQube local (opcional)

El análisis local con Docker descrito en el README sigue disponible para revisar una rama antes de abrir el PR; el análisis oficial es el de SonarQube Cloud.

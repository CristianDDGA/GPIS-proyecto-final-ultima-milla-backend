# Contrato de cuentas: registro, verificación de correo y recuperación de clave

Referencia para el frontend. Complementa `openapi.yaml`, que no documenta `/auth`. Todas las respuestas de error usan el
sobre común `{ "code", "message", "error": { "code", "message" } }`.

## Quién verifica su correo

| Rol | Cómo se crea | Verificación de correo |
|---|---|---|
| `cliente` | Se registra solo (`POST /auth/register`) | **Sí**, con un código de 6 dígitos enviado al correo |
| `repartidor` | Lo crea el administrador (`POST /auth/users`) | No: nace verificado; el correo puede ser ficticio |
| `personal` (admin) | Semilla o creado por otro administrador | No |

`EMAIL_VERIFICATION_REQUIRED=false` activa el **modo demo**: el cliente nace verificado, recibe token al registrarse y no
se envía correo. Los usuarios anteriores a la migración `007` quedaron verificados.

## Flujo del cliente

1. `POST /auth/register` `{ email, password, displayName? }`
   - Modo normal: `201 { user, verificationRequired: true }`. **No devuelve token.** Se envía el código al correo.
   - Modo demo: `201 { user, token }`.
   - `409 EMAIL_ALREADY_EXISTS` si el correo ya existe.
2. `POST /auth/verify-email` `{ email, code }` → `200 { user, token }` (verifica y abre sesión).
3. `POST /auth/resend-verification` `{ email }` → `202 { message }` siempre (exista o no la cuenta). Máximo un envío por minuto.
4. `POST /auth/login` con el correo sin verificar → `403 EMAIL_NOT_VERIFIED` (solo si la clave es correcta).

El código: 6 dígitos, caduca en 15 minutos, de un solo uso; 5 intentos fallidos lo invalidan.

| Código de error | HTTP | Cuándo |
|---|---|---|
| `INVALID_CODE` | 400 | Código incorrecto, ya usado, o correo desconocido (no se distingue a propósito) |
| `CODE_EXPIRED` | 400 | Pasaron más de 15 minutos: pedir uno nuevo |
| `CODE_LOCKED` | 429 | Quinto intento fallido: pedir uno nuevo |
| `EMAIL_NOT_VERIFIED` | 403 | Login de una cuenta sin verificar |
| `VALIDATION_ERROR` | 400 | `code` no tiene exactamente 6 dígitos, clave débil, formato inválido |

## Recuperar la clave

1. `POST /auth/forgot-password` `{ email }` → `202 { message }` siempre. Solo envía código a cuentas cuyo correo se
   verificó con un código (clientes). Conductores, administradores y cuentas en modo demo no reciben código.
2. `POST /auth/reset-password` `{ email, code, newPassword }` → `200 { ok: true }`. Cierra **todas** las sesiones anteriores.

## Cambiar la clave (con sesión)

`POST /auth/change-password` `{ currentPassword, newPassword }` con `Authorization: Bearer` → `200 { user, token }`.
Cierra las demás sesiones y devuelve un token nuevo para el dispositivo actual. `400` si la clave actual es incorrecta o
la nueva es igual a la actual.

## Administración

- `POST /auth/users` `{ email, password, role, displayName? }` (solo `personal`) → `201 { user }`. La cuenta nace verificada.
- `POST /auth/users/:id/reset-password` `{ newPassword }` (solo `personal`) → `200 { ok: true }`. Pensado para conductores
  con correo ficticio. Cierra las sesiones del usuario. `404 USER_NOT_FOUND` si no existe.

## Objeto `user`

`{ id, authSubject, email, role, publicRole, displayName, isActive, courierId, emailVerified }`

## Gestión de usuarios (solo `personal`)

| Endpoint | Descripción |
|---|---|
| `GET /auth/users` | Lista usuarios. Filtros: `role` (`admin`, `repartidor`, `cliente`), `isActive` (`true`/`false`), `q` (texto en correo o nombre, hasta 100 caracteres), `limit` (1 a 100, por defecto 25) y `offset`. Responde `{ items, total, limit, offset }` |
| `GET /auth/users/:id` | `{ user }` o `404 USER_NOT_FOUND` |
| `PATCH /auth/users/:id` | `{ isActive: boolean }` activa o desactiva la cuenta. Responde `{ user }`. Es idempotente |

Cada elemento de `items` es el objeto `user` más `createdAt` (ISO UTC) y `emailVerifiedVia` (`code`, `admin`, `legacy`, `demo` o `null`).
Nunca incluye el hash de la clave. Un cliente o conductor recibe `403 FORBIDDEN`.

Al **desactivar** una cuenta se cierran todas sus sesiones y el login responde `403 USER_INACTIVE`. Reglas de negocio, todas `409`:

| Código | Cuándo |
|---|---|
| `CANNOT_DEACTIVATE_SELF` | El administrador intenta desactivar su propia cuenta |
| `LAST_ADMIN` | Sería el último administrador activo |
| `USER_HAS_ACTIVE_ROUTE` | Es un repartidor con una ruta asignada o en curso: reasignar o cerrar la ruta antes |

## Registro de eventos de seguridad

El servidor escribe una línea JSON por evento en la salida estándar (`"channel":"security"`): `register`, `email_verified`,
`login_success`, `login_failed`, `login_locked`, `login_unverified`, `password_reset`, `password_changed`,
`admin_password_reset`, `user_created_by_admin`, `user_deactivated` y `user_activated`. El correo va enmascarado
(`a***@dominio.com`) y nunca se registran contraseñas ni códigos. Sirve de evidencia de auditoría y para detectar abuso.

## Bloqueo por cuenta y política de contraseñas

- **Bloqueo:** 5 inicios de sesión fallidos en 15 minutos bloquean la cuenta 5 minutos. Responde `429 ACCOUNT_LOCKED` con
  `Retry-After` (segundos), **incluso con la clave correcta**, y aplica también a correos que no existen (no revela qué
  cuentas existen). Un login correcto reinicia el contador. El estado vive en memoria: se reinicia con el servidor.
  Configurable con `LOGIN_MAX_FAILED_ATTEMPTS` (5) y `LOGIN_LOCK_SECONDS` (300). El frontend debe mostrar el tiempo de espera.
- **Contraseñas nuevas** (registro, `change-password`, `reset-password`, restablecimiento del admin): entre 8 y 128 caracteres y
  `400 VALIDATION_ERROR` si es una clave común (`password`, `12345678`, `qwerty123`...), una palabra débil con adornos
  (`Password2026!`, `Admin#2026`), de un solo carácter repetido, solo números o si contiene el correo del usuario. No se exige
  mezclar mayúsculas, números y símbolos: una frase larga es válida. El login no aplica esta política (solo el largo).
- **Vigencia del token:** 8 horas por defecto (`JWT_EXPIRES_IN_SECONDS`, antes 24 horas). Al vencer hay que iniciar sesión de nuevo.

## Límites de uso

`/auth/login`, `/auth/register`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password` y
`/auth/reset-password` aplican un límite por IP (por defecto 20 solicitudes por minuto) y responden `429 TOO_MANY_REQUESTS`
con `Retry-After`.

## Variables de entorno

`EMAIL_VERIFICATION_REQUIRED` (por defecto `true`), `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM`. Sin `SMTP_HOST`, los correos se escriben en la consola del servidor (solo desarrollo); en producción con la
verificación activa, `SMTP_HOST` es obligatorio. Para pruebas de carga y ZAP usar `EMAIL_VERIFICATION_REQUIRED=false`.

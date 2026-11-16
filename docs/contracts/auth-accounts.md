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

## Límites de uso

`/auth/login`, `/auth/register`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password` y
`/auth/reset-password` aplican un límite por IP (por defecto 20 solicitudes por minuto) y responden `429 TOO_MANY_REQUESTS`
con `Retry-After`.

## Variables de entorno

`EMAIL_VERIFICATION_REQUIRED` (por defecto `true`), `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM`. Sin `SMTP_HOST`, los correos se escriben en la consola del servidor (solo desarrollo); en producción con la
verificación activa, `SMTP_HOST` es obligatorio. Para pruebas de carga y ZAP usar `EMAIL_VERIFICATION_REQUIRED=false`.

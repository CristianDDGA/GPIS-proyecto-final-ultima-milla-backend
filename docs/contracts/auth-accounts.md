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

## Perfil propio (migración 015)

Para la pantalla "Mi perfil" de cualquier rol (con sesión):

- `GET /auth/me/profile` → `200 { profile }`.
- `PATCH /auth/me/profile` `{ displayName?, phone? }` → `200 { profile }`. Lo que no se envía queda igual; `null` o `""`
  borra el valor. Otro campo, o un cuerpo sin ninguno de los dos, responde `400 VALIDATION_ERROR`.
  - `displayName`: misma regla que el registro (solo letras, espacios, apóstrofo, guion y punto).
  - `phone`: de 7 a 15 dígitos, `+` inicial opcional; espacios y guiones se aceptan y se guardan sin ellos
    (`"+593 99 123 4567"` → `"+593991234567"`).

Objeto `profile`:

```json
{ "id": "…", "email": "…", "role": "cliente", "publicRole": "cliente", "displayName": "Ana Pérez",
  "phone": "+593991234567", "emailVerified": true, "hasPassword": true, "googleLinked": false,
  "createdAt": "2026-11-19T15:04:05.000Z" }
```

- `hasPassword: false` en una cuenta creada solo con Google: el frontend no debe ofrecer "Cambiar contraseña".
- `googleLinked`: la cuenta puede entrar con Google.
- El objeto `user` de `/auth/me` y del inicio de sesión no cambia.

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

## Iniciar sesión con Google (migración 014)

Botón "Continuar con Google". El navegador obtiene un **ID token** de Google (Google Identity Services) y el frontend lo envía al backend, que lo
verifica (firma con las claves públicas de Google, emisor, vigencia y que sea para **nuestro** Client ID). No hay contraseñas de Google en el backend.

`POST /auth/google` (pública, con límite de uso por IP)

```json
{ "idToken": "<el credential que entrega Google>" }
```

Respuesta `200`: igual que `/auth/login` → `{ "token": "<JWT de 8 h>", "user": { ... } }`.

| Situación | Resultado |
| --- | --- |
| Primera vez, correo nuevo | Se crea un **cliente** con el correo verificado (`emailVerifiedVia: "google"`) y **sin contraseña** |
| Ya entró antes con esa cuenta de Google | Entra a la misma cuenta (se identifica por el `sub` de Google, aunque cambie su correo) |
| Existe un **cliente** con ese correo confirmado por código | Se **vincula**: conserva su contraseña y desde ahora también entra con Google |
| El correo es de un administrador o conductor, o el cliente no confirmó su correo | `403 GOOGLE_NOT_ALLOWED` (esas cuentas entran con correo y contraseña) |
| Google no confirma el correo (`email_verified` falso) | `403 GOOGLE_NOT_ALLOWED` |
| Cuenta desactivada | `403 USER_INACTIVE` |
| Token inventado, de otra app, caducado o mal firmado | `401 INVALID_GOOGLE_TOKEN` |
| El servidor no tiene `GOOGLE_CLIENT_ID` | `503 GOOGLE_NOT_ENABLED` (el botón debe ocultarse) |
| No se pudieron obtener las claves de Google | `503 PERSISTENCE_UNAVAILABLE` (reintentar) |

Notas:
- Un cliente vinculado a Google que luego es aprobado como conductor (solicitud de conductor) conserva su vinculación y puede seguir entrando con Google.
- Una cuenta creada con Google no tiene contraseña: "olvidé mi contraseña" no le envía nada y `change-password` no aplica; entra siempre con Google.
- Recibe los correos del pedido igual que el resto: Google prueba que el correo es suyo.
- El nombre de Google se usa como `displayName` solo si cumple la validación de nombres; si trae números o emojis, la cuenta queda sin nombre.

### Frontend (web)

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script>
  google.accounts.id.initialize({
    client_id: '<GOOGLE_CLIENT_ID>.apps.googleusercontent.com',   // público
    callback: async ({ credential }) => {
      const r = await fetch(`${API}/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: credential }) });
      const session = await r.json();                              // { token, user } → misma sesión que /auth/login
    },
  });
  google.accounts.id.renderButton(document.getElementById('google'), { theme: 'outline', size: 'large', text: 'continue_with', locale: 'es' });
</script>
```

El origen del frontend (`http://localhost:5173` y el dominio de producción) debe estar en *Authorized JavaScript origins* del Client ID. El mismo Client ID sirve
para la web; la app móvil necesita su propio Client ID de Android/iOS y el backend debe aceptarlo (hoy solo valida el de la web).

## Límites de uso

`/auth/login`, `/auth/register`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password` y
`/auth/reset-password` aplican un límite por IP (por defecto 20 solicitudes por minuto) y responden `429 TOO_MANY_REQUESTS`
con `Retry-After`.

## Variables de entorno

`EMAIL_VERIFICATION_REQUIRED` (por defecto `true`), `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM`. Sin `SMTP_HOST`, los correos se escriben en la consola del servidor (solo desarrollo); en producción con la
verificación activa, `SMTP_HOST` es obligatorio. Para pruebas de carga y ZAP usar `EMAIL_VERIFICATION_REQUIRED=false`.

## Solicitud para ser conductor

Un cliente puede pedir ser conductor y el administrador la aprueba: ver `courier-applications.md` (formulario, subida de la licencia y la foto, estados, qué pasa con la cuenta al aprobar). Variable `COURIER_UPLOADS_DIR`: carpeta privada de las imágenes.

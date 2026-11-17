# Contrato: solicitud para ser conductor

Referencia para el frontend. Un cliente envía una solicitud con sus datos, la foto de su licencia y su foto; el
administrador la revisa y la aprueba o la rechaza. Al aprobarla, la misma cuenta pasa de `cliente` a `repartidor`
(conductor). Todas las respuestas de error usan el sobre común `{ "code", "message", "error": { "code", "message" } }`.

La creación directa de conductores por el administrador (`POST /auth/users`) sigue existiendo y es independiente.

## Estados

```
borrador ──submit──▶ pendiente ──approve──▶ aprobada   (la cuenta pasa a repartidor)
   │                    │└────reject───▶ rechazada      (sigue siendo cliente; puede enviar otra)
   └──cancel────────────┴────cancel───▶ cancelada
```

- `borrador`: el cliente llena datos y sube imágenes. El administrador no lo ve.
- `pendiente`: enviada; ya no se edita. Solo se puede cancelar.
- `aprobada` / `rechazada` / `cancelada`: estados finales. Tras `rechazada` o `cancelada` el cliente puede empezar otra.
- Un cliente tiene **una sola** solicitud abierta (`borrador` o `pendiente`).

## Cliente (solo rol `cliente`; el resto recibe `403`)

| Método y ruta | Qué hace |
|---|---|
| `GET /courier-applications/me` | `200 { application }`: la más reciente en cualquier estado, o `application: null` |
| `PUT /courier-applications/me` | Crea o actualiza el **borrador** con los datos del formulario. `200 { application }` |
| `PUT /courier-applications/me/files/:kind` | Sube o reemplaza una imagen del borrador. `:kind` = `license` o `photo`. `200 { application }` |
| `GET /courier-applications/me/files/:kind` | Descarga la imagen subida (para previsualizarla) |
| `POST /courier-applications/me/submit` | Envía el borrador: pasa a `pendiente`. `200 { application }` |
| `POST /courier-applications/me/cancel` | Cancela la solicitud abierta. `200 { application }` |

### Formulario (`PUT /courier-applications/me`, JSON)

| Campo | Regla |
|---|---|
| `fullName` | Nombres y apellidos (al menos dos palabras), solo letras, espacios, apóstrofo, guion y punto |
| `nationalId` | Cédula ecuatoriana de 10 dígitos: provincia 01–24 o 30, tercer dígito menor que 6 y dígito verificador correcto. Valida que el número esté bien formado; que exista y sea de esa persona lo comprueba el administrador contra la foto de la licencia |
| `phone` | 7 a 15 dígitos, puede iniciar con `+`; espacios y guiones solo entre dígitos (se normalizan) |
| `birthDate` | `AAAA-MM-DD`, existir en el calendario y tener **18 años cumplidos** |
| `vehicleType` | `moto`, `auto` o `camioneta` |
| `licenseNumber` | 4 a 20 caracteres: letras y números, con guiones solo entre grupos (se pasa a mayúsculas) |
| `licenseCategory` | `A`, `A1`, `B`, `C`, `C1`, `D`, `D1`, `E`, `E1`, `F` o `G` |
| `licenseExpiresOn` | `AAAA-MM-DD`, posterior a hoy (hora de Ecuador) |

Es un `PUT`: se reenvía el formulario completo cada vez. Requiere el correo verificado.

### Subir una imagen (`PUT /courier-applications/me/files/:kind`)

**No es multipart.** El cuerpo es la imagen en binario y el `Content-Type` es el de la imagen:

```js
await fetch(`${API}/courier-applications/me/files/license`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type }, // image/jpeg o image/png
  body: file,                                                               // el File del <input type="file">
});
```

- Solo JPEG o PNG, **máximo 5 MB**. El servidor comprueba el contenido real, no la extensión ni el `Content-Type`.
- Subir otra vez el mismo `kind` reemplaza la anterior. Solo se puede mientras la solicitud sea `borrador`.
- Orden recomendado: `PUT /me` (datos) → `PUT` de las dos imágenes → `POST /me/submit`.
- Para previsualizar: `GET /me/files/:kind` con el token (no es una URL pública; use `fetch` + `URL.createObjectURL`).

### Objeto `application`

```json
{
  "id": "uuid", "userId": "uuid", "status": "pendiente",
  "fullName": "Carlos Andrade Mora", "nationalId": "1712345675", "phone": "0991234567",
  "birthDate": "1995-04-20", "vehicleType": "moto",
  "licenseNumber": "EC-123456", "licenseCategory": "A", "licenseExpiresOn": "2030-01-31",
  "files": [
    { "kind": "license", "contentType": "image/jpeg", "sizeBytes": 183201, "uploadedAt": "2026-11-16T15:04:05.000Z" },
    { "kind": "photo", "contentType": "image/png", "sizeBytes": 90412, "uploadedAt": "2026-11-16T15:04:30.000Z" }
  ],
  "submittedAt": "2026-11-16T15:05:00.000Z", "reviewedAt": null,
  "rejectionReason": null, "approvedCapacity": null, "createdAt": "2026-11-16T15:03:00.000Z"
}
```

`files` indica qué imágenes ya subió el cliente (para marcar los pasos completos). Las imágenes en sí solo se obtienen con
los `GET .../files/:kind`.

## Administrador (solo rol `personal`; el resto recibe `403`)

| Método y ruta | Qué hace |
|---|---|
| `GET /courier-applications` | Lista las solicitudes **enviadas** (nunca borradores). Query: `status` (`pendiente`, `aprobada`, `rechazada`, `cancelada`), `q` (nombre, correo o cédula), `limit` (1–100, def. 25), `offset`. Responde `{ items, total, limit, offset }`, con las pendientes primero |
| `GET /courier-applications/:id` | `200 { application }` con `applicantEmail` y `applicantName` |
| `GET /courier-applications/:id/files/:kind` | La imagen (`license` o `photo`) |
| `POST /courier-applications/:id/approve` | Aprueba. Cuerpo opcional `{ "capacity": 12 }` (pedidos por viaje, entero 1–200; por defecto 10) |
| `POST /courier-applications/:id/reject` | Rechaza. Cuerpo `{ "reason": "..." }` obligatorio, 5 a 500 caracteres; solo letras, números, espacios y `. , ; : ( ) ¿ ? ¡ ! % / -` (sin emojis ni símbolos) |

Cada elemento de `items` y el detalle son el mismo objeto `application` más `applicantEmail` y `applicantName`.

### Qué pasa al aprobar

En una sola transacción: el rol de la cuenta cambia a `repartidor`, se crea su ficha de conductor (`courierId`, con el nombre
de la solicitud y la capacidad indicada) y **se cierran todas sus sesiones**. Se le envía un correo.

Consecuencias para el frontend del solicitante:

1. Su siguiente petición con el token anterior responde `401`. Debe llevarlo a la pantalla de login con un aviso del tipo
   "Tu solicitud fue aprobada, inicia sesión de nuevo".
2. Al iniciar sesión, `user.role` es `repartidor` y `user.courierId` viene lleno: se muestra el panel de conductor.
3. Como ya no es cliente, `/courier-applications/me` responde `403` y **deja de ver los pedidos que hizo como cliente**.

Al rechazar no cambia nada en la cuenta: sigue con la misma sesión, ve `status: "rechazada"` y `rejectionReason`, y puede
volver a llamar a `PUT /courier-applications/me` para empezar otra solicitud (nace como `borrador` nuevo y sin imágenes).

Para enterarse de la decisión sin esperar al correo, el frontend del cliente puede consultar `GET /me` al abrir la app.

## Errores

| Código | HTTP | Cuándo |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Formulario inválido, `:kind` o `:id` inválido, imagen vacía, motivo o capacidad inválidos, parámetros de lista inválidos |
| `UNAUTHORIZED` | 401 | Sin token, token vencido o sesión cerrada |
| `FORBIDDEN` | 403 | Rol incorrecto para la ruta |
| `EMAIL_NOT_VERIFIED` | 403 | El cliente aún no verificó su correo |
| `APPLICATION_NOT_FOUND` | 404 | La solicitud no existe o es un borrador (para el administrador) |
| `FILE_NOT_FOUND` | 404 | Esa imagen no se subió |
| `NO_OPEN_APPLICATION` | 409 | No hay borrador (subir, enviar) o solicitud abierta (cancelar) |
| `ALREADY_PENDING` | 409 | Ya hay una solicitud pendiente: no se edita |
| `MISSING_FILES` | 409 | Faltan la licencia o la foto al enviar |
| `NOT_PENDING` | 409 | Ya fue aprobada, rechazada o cancelada |
| `DUPLICATE_NATIONAL_ID` | 409 | Otra solicitud vigente (pendiente o aprobada) usa esa cédula |
| `APPLICANT_NOT_CLIENT` | 409 | Al aprobar: el solicitante ya no es un cliente activo |
| `FILE_TOO_LARGE` | 413 | La imagen supera 5 MB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | No es JPEG o PNG |
| `PERSISTENCE_UNAVAILABLE` | 503 | Base de datos o almacenamiento no disponible |

## Seguridad y privacidad

- Las imágenes se guardan en una carpeta privada del servidor (`COURIER_UPLOADS_DIR`), con nombres aleatorios, **nunca** como
  archivos estáticos. Solo se descargan con token: el administrador cualquier solicitud enviada; el cliente, las suyas.
- Cada descarga lleva `Content-Security-Policy: default-src 'none'; sandbox` y `X-Content-Type-Options: nosniff`.
- En el registro de eventos de seguridad quedan `courier_application_submitted`, `_cancelled`, `_approved` y `_rejected`
  (correo enmascarado; nunca la cédula, el teléfono ni las imágenes).
- La carpeta de imágenes debe incluirse en las copias de seguridad junto con la base de datos.

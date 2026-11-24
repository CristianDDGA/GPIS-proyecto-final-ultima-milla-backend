# Contrato de la tienda (`/store`)

Catálogo de productos, administración, franjas de entrega y pedidos con productos. Todo vive en el mismo puerto 3000.
Es **aditivo**: `POST /orders` y el flujo de rutas y entregas no cambian. Un pedido de tienda es un pedido normal
(aparece en `/orders` para el despacho) más sus líneas de producto.

## Reglas generales

- **Autenticación:** `Authorization: Bearer <token>` en todo, salvo `GET /store/images/:key` (pública, para etiquetas `<img>`).
- **Roles:** `cliente` compra y consulta; `personal` (administrador) administra y consulta; `repartidor` no usa la tienda.
  Cualquier ruta de `/store` no listada aquí se niega a quien no sea administrador.
- **Dinero:** enteros en **centavos** de USD (`priceCents: 6999` = USD 69,99). Nunca decimales ni texto.
  Máximo 100.000.000 (USD 1.000.000,00).
- **Errores:** `{ "code": "...", "message": "...", "error": { "code": "...", "message": "..." }, "details"?: ... }`.
- **Texto:** lista blanca estricta. Letras latinas (con tildes y ñ), **números**, espacios y puntuación básica.
  Emojis, símbolos (™ © ★ →), caracteres invisibles, texto apilado y otros alfabetos se rechazan con `400 VALIDATION_ERROR`.
- **Campos desconocidos:** se rechazan con `400` (no se ignoran en silencio).
- **Paginación:** `page` (desde 1) y `pageSize` (1 a 50). Respuesta: `{ items, page, pageSize, total }`.

| Código | HTTP | Significado |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Datos inválidos (el `message` explica cuál) |
| `UNAUTHORIZED` / `FORBIDDEN` | 401 / 403 | Sin sesión / sin permiso |
| `PRODUCT_NOT_FOUND`, `CATEGORY_NOT_FOUND`, `ORDER_NOT_FOUND`, `ZONE_NOT_FOUND`, `IMAGE_NOT_FOUND` | 404 | No existe (un pedido ajeno también responde 404) |
| `DUPLICATE_SKU`, `DUPLICATE_CATEGORY` | 409 | Ya existe |
| `VERSION_CONFLICT` | 409 | Otro administrador editó antes: recarga y reintenta |
| `INSUFFICIENT_STOCK` | 409 | Un ajuste dejaría el stock negativo |
| `ORDER_CONFLICT` | 409 | El pedido no se pudo completar; ver `details.conflicts` |
| `OPERATION_IN_PROGRESS` | 409 | La misma clave sigue en proceso; reintenta tras `Retry-After` |
| `IDEMPOTENCY_KEY_REUSED` | 422 | La misma `Idempotency-Key` con un pedido distinto |
| `FILE_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 413 / 415 | Imagen demasiado grande / no es JPEG ni PNG |
| `PERSISTENCE_UNAVAILABLE` | 503 | Servicio no disponible temporalmente |
| (límite de frecuencia) | 429 | Demasiados pedidos desde la misma IP (30 por minuto) |

## Catálogo (cliente y administrador)

### `GET /store/categories`
`{ "items": [{ "id", "name", "isActive": true, "version" }] }` (solo activas).

### `GET /store/products`
Filtros (todos opcionales):

| Parámetro | Valores |
|---|---|
| `q` | Texto, hasta 60 caracteres. Sin tildes ni mayúsculas, por prefijos, sobre nombre, marca, descripción y categoría |
| `categoryId` | UUID |
| `minPriceCents`, `maxPriceCents` | Enteros (mínimo ≤ máximo) |
| `onSale` | `true` o `false` |
| `sort` | `relevance` (por defecto), `price_asc`, `price_desc`, `newest`, `discount` |
| `page`, `pageSize` | Por defecto 1 y 12 |

Cada producto (vista de cliente, **sin** versión, estado interno ni stock exacto):

```json
{
  "id": "…", "sku": "AUD-100", "name": "Audífonos inalámbricos serie 100", "brand": "SoundMax",
  "description": "…", "category": { "id": "…", "name": "Deportes y fitness" },
  "priceCents": 6999, "compareAtPriceCents": 8999, "discountPercent": 22,
  "availability": "in_stock", "lowStockRemaining": null, "imageUrl": "/store/images/<32 hex>.png"
}
```

- `availability`: `in_stock`, `low_stock` (quedan 5 o menos; `lowStockRemaining` trae la cantidad) o `out_of_stock`
  (se muestra pero no se puede comprar).
- `imageUrl`: `null` sin imagen; una ruta relativa de la API (`/store/images/…`, anteponer la URL base) o una URL
  absoluta de la CDN de Supabase. Úsala tal cual en `<img src>`.

### `GET /store/products/:id`
Un producto (404 si no existe o no es visible).

### `GET /store/delivery-slots?zoneId=<uuid>&date=AAAA-MM-DD`
Una franja por hora, con cupo por zona, fecha y hora:

```json
{ "zoneId": "…", "date": "2030-05-10", "items": [{ "time": "08:00", "capacity": 10, "reserved": 3, "available": true }] }
```

`available` es falso si la franja está llena o ya no cumple la anticipación mínima. 404 si la zona no existe o está inactiva.

## Pedidos

### `POST /store/orders` (solo `cliente`)
Cabecera **obligatoria**: `Idempotency-Key: <uuid>`. Genera una clave nueva **por intento de compra**, y reutilízala solo
para reintentar ese mismo intento (cierre de pantalla, mala conexión, doble clic).

```json
{
  "zoneId": "…", "deliveryAddress": "Av. 9 de Octubre 123 y Malecón",
  "deliveryDate": "2030-05-10", "deliveryTime": "14:00",
  "recipientName": "María José Pérez", "recipientPhone": "+593 99 123 4567", "notes": "Tocar el timbre dos veces.",
  "items": [{ "productId": "…", "quantity": 2, "unitPriceCents": 6999 }]
}
```

- `deliveryTime` es una hora en punto (`HH:00`) dentro del horario de la tienda. `recipientName`, `recipientPhone` y `notes` son opcionales.
- `items`: de 1 a 20 líneas, sin productos repetidos, cantidad de 1 a 10. `unitPriceCents` es **el precio que el cliente vio**:
  si cambió, el pedido se rechaza y no se cobra de más.
- **201** con el pedido (ver abajo). Un reintento con la misma clave devuelve **200**, el mismo pedido y la cabecera
  `Idempotent-Replayed: true`, sin descontar stock otra vez.
- **409 `ORDER_CONFLICT`**: nada se escribió. `details.conflicts` lista cada problema:

```json
{ "code": "ORDER_CONFLICT", "message": "El precio de uno de los productos cambió. Revisa el carrito.",
  "details": { "conflicts": [
    { "reason": "price_changed", "productId": "…", "currentPriceCents": 7500 },
    { "reason": "insufficient_stock", "productId": "…", "available": 1 },
    { "reason": "unavailable", "productId": "…" },
    { "reason": "slot_full", "capacity": 10 }
  ] } }
```

  Razones: `unavailable`, `price_changed`, `insufficient_stock`, `slot_invalid`, `slot_unavailable`, `slot_full`, `zone_inactive`.
  Un conflicto queda como el resultado de esa clave: **tras corregir el carrito, usa una `Idempotency-Key` nueva**.
- **422** si la misma clave se usó con otro contenido.

Pedido:

```json
{
  "id": "…", "status": "pendiente", "zoneId": "…", "deliveryAddress": "…", "deliveryDate": "2030-05-10",
  "deliveryTime": "14:00", "totalCents": 13998, "itemsCount": 1, "paymentMethod": "contra_entrega", "createdAt": "…",
  "customerId": "…", "recipientName": null, "recipientPhone": null, "notes": null,
  "items": [{ "productId": "…", "sku": "AUD-100", "name": "…", "unitPriceCents": 6999, "quantity": 2,
              "lineTotalCents": 13998, "imageUrl": null }]
}
```

El nombre y el precio de cada línea son una **copia del momento de la compra**: no cambian si el catálogo cambia después.
`status` sigue el ciclo de entrega existente (`pendiente → asignado_a_ruta → recogido → en_camino → entregado`).

### `GET /store/orders?page=&pageSize=`
Un cliente ve solo sus pedidos; el administrador ve todos. Resumen sin líneas, del más reciente al más antiguo.

### `GET /store/orders/:id`
Detalle con líneas. Un pedido ajeno responde 404.

Desde la migración 015 el detalle (y la respuesta de `POST /store/orders`) trae también el seguimiento:

```json
{
  "history": [
    { "status": "pendiente", "at": "2026-11-23T21:36:09.981Z" },
    { "status": "asignado_a_ruta", "at": "2026-11-23T21:50:12.004Z" },
    { "status": "en_camino", "at": "2026-11-23T22:05:40.511Z" }
  ],
  "courier": { "firstName": "Pablo" }
}
```

- `history`: la creación y cada cambio de estado, en orden, con la hora (ISO UTC). Las ediciones de datos no aparecen.
  Un pedido reprogramado puede repetir estados (`entrega_fallida → pendiente → asignado_a_ruta …`).
- `courier`: solo el **nombre de pila** del repartidor mientras el pedido está en una ruta asignada o en curso; `null`
  antes de asignarse y cuando la ruta se cierra. Nunca incluye teléfono ni otros datos del repartidor.

## Imágenes

### `GET /store/images/:key` (pública)
Sirve la imagen (o redirige a la CDN con 302). Cabeceras: `Cache-Control: public, max-age=31536000, immutable`,
`Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`.

## Administración (solo `personal`)

Los cambios con control de versión exigen `expectedVersion` (la `version` que el formulario cargó). Si otro administrador
guardó antes, responde `409 VERSION_CONFLICT` y no cambia nada.

| Método y ruta | Cuerpo | Notas |
|---|---|---|
| `GET /store/admin/categories` | | Incluye inactivas |
| `POST /store/admin/categories` | `{ "name" }` | 201. Nombre único sin distinguir mayúsculas |
| `PATCH /store/admin/categories/:id` | `{ "expectedVersion", "name"?, "isActive"? }` | Desactivar oculta sus productos al cliente |
| `GET /store/admin/products` | | Filtros como el catálogo y `status=active\|inactive\|all` (por defecto `all`). Trae `stockQuantity`, `isActive`, `version` |
| `POST /store/admin/products` | `{ "sku", "name", "brand"?, "description"?, "categoryId", "priceCents", "compareAtPriceCents"?, "stock", "isActive"? }` | 201. La imagen se sube después |
| `GET /store/admin/products/:id` | | |
| `PATCH /store/admin/products/:id` | `{ "expectedVersion", …campos }` | Campos: `name`, `brand`, `description`, `categoryId`, `priceCents`, `compareAtPriceCents`, `isActive`. `null` borra marca, descripción u oferta. El SKU y el stock no se editan aquí |
| `POST /store/admin/products/:id/stock-adjustments` | `{ "delta", "reason" }` | `delta` entero distinto de 0; `reason`: `restock`, `correction`, `damage`. Responde `{ id, stock }`. Es por diferencia: dos ajustes simultáneos se suman |
| `GET /store/admin/products/:id/events` | | Historial: quién cambió qué y cuándo |
| `PUT /store/admin/products/:id/image?expectedVersion=N` | Binario, `Content-Type: image/jpeg` o `image/png` | Máximo 5 MB y 4096 x 4096 px (mínimo 64 x 64). Se valida el tipo real por la firma del archivo |
| `DELETE /store/admin/products/:id/image?expectedVersion=N` | | |
| `GET /store/admin/settings` · `PUT /store/admin/settings` | `{ "slotCapacity", "firstSlotHour", "lastSlotHour", "minLeadMinutes" }` | Cupo por franja (1 a 500), horario (0 a 23) y anticipación mínima en minutos |

El stock de un producto cambia con ajustes del administrador (`stock-adjustments`) y con cada compra. Cada cambio queda en
un libro de movimientos: el stock actual siempre es la suma de sus movimientos.

## Flujos por rol (migración 011)

Todo lo anterior sigue igual. Esta sección **agrega** endpoints y estados; no cambia ninguna respuesta existente de
`/store`, `/orders`, rutas ni entregas, salvo lo indicado en "Compatibilidad".

### Estados del pedido

`pendiente → asignado_a_ruta → recogido → en_camino → entregado`, más dos estados nuevos:

- `cancelado`: desde `pendiente`, `asignado_a_ruta` o `entrega_fallida` (con la ruta ya cerrada). Es final.
- `entrega_fallida`: el conductor no pudo entregar (desde `en_camino`). La parada sigue en su ruta hasta que la ruta se
  cierra; después el pedido se **reprograma** (vuelve a `pendiente`) o se **cancela**. Máximo **3 intentos** de entrega.

### Cliente (dueño) y administrador

| Endpoint | Cuerpo | Notas |
| --- | --- | --- |
| `POST /store/orders/:id/cancel` | `{ "reason", "note"? }` | `reason`: `cliente_desiste`, `error_en_pedido`, `sin_stock`, `no_localizable`, `demora`, `otro`. Devuelve el stock una sola vez y libera la franja. Idempotente: cancelar algo ya cancelado responde `200` con `alreadyCancelled: true`. |
| `POST /store/orders/:id/reschedule` | `{ "deliveryDate", "deliveryTime" }` | Solo con `entrega_fallida` y ruta cerrada. Hora en punto. `409 SCHEDULE_CONFLICT` con `details.reason` (`slot_invalid`, `slot_unavailable`, `slot_full`). |
| `GET /store/addresses` | | Libreta del cliente (máximo 10). La predeterminada va primero. |
| `POST /store/addresses` | `{ "label", "zoneId", "address", "recipientName"?, "recipientPhone"?, "isDefault"? }` | La primera siempre es predeterminada. `409 DUPLICATE_ADDRESS` / `ADDRESS_LIMIT`. |
| `PATCH /store/addresses/:id` | `{ "expectedVersion", ...campos }` | `409 VERSION_CONFLICT` si cambió. No se puede quitar la marca de predeterminada sin elegir otra. |
| `DELETE /store/addresses/:id` | | `204`. Si era la predeterminada, otra pasa a serlo. |

El cliente solo puede cancelar y reprogramar **sus** pedidos (si no, `404 ORDER_NOT_FOUND`). Un pedido recogido, en camino,
entregado o con la ruta abierta responde `409 ORDER_NOT_CANCELLABLE` / `ORDER_NOT_RESCHEDULABLE`; tras 3 intentos fallidos
reprogramar responde `409 MAX_DELIVERY_ATTEMPTS` y solo queda cancelar.

### Conductor (`repartidor`)

| Endpoint | Cuerpo | Notas |
| --- | --- | --- |
| `GET /store/courier/orders` | | Sus paradas con `version`, dirección, destinatario, `totalCents` a cobrar, productos (`items`) y `failedAttempts`. |
| `POST /store/courier/orders/:id/deliver` | `{ "expectedVersion", "collectedCents" }` + `Idempotency-Key` | El monto cobrado debe ser **exactamente** el total (`422 COLLECTION_AMOUNT_MISMATCH`). Registra el efectivo y marca `entregado`. |
| `POST /store/courier/orders/:id/fail` | `{ "expectedVersion", "reason", "note"? }` + `Idempotency-Key` | `reason`: `cliente_ausente`, `direccion_incorrecta`, `cliente_rechazo`, `zona_inaccesible`, `otro`. Devuelve el número de `attempt`. |
| `GET /store/courier/cash?date=AAAA-MM-DD` | | Lo cobrado ese día (Ecuador) y, si ya se rindió, la diferencia. |

Reintentar con la misma `Idempotency-Key` devuelve el mismo resultado con la cabecera `Idempotent-Replayed: true`; la misma
clave con otro monto o motivo responde `422 IDEMPOTENCY_KEY_REUSED`. `409 STALE_ORDER` significa que el pedido cambió o ya no
está en su ruta: hay que refrescar la lista.

### Administrador (`personal`)

| Endpoint | Notas |
| --- | --- |
| `GET /store/admin/orders?status=&deliveryDate=&zoneId=&expand=items&page=&pageSize=` | Despacho: pedidos de la tienda con cliente, destinatario y, con `expand=items`, sus productos. |
| `GET /store/admin/low-stock?threshold=5&limit=50` | Productos con stock igual o menor al umbral. |
| `GET /store/admin/summary?from=&to=` | Pedidos por estado, ventas (`grossCents`, sin cancelados), cobrado, cancelaciones y fallas por motivo, top 5 de productos. |
| `GET /store/admin/cash?date=` | Cobrado por conductor y su rendición. |
| `POST /store/admin/cash/settlements` | `{ "courierUserId", "date", "receivedCents", "note"? }`. Una sola rendición por conductor y día (`409 ALREADY_SETTLED`); sin cobros, `409 NOTHING_TO_SETTLE`. Devuelve `expectedCents`, `receivedCents` y `differenceCents`. |

### Avisos por correo al cliente

Cada pedido de tienda deja un aviso en cola, dentro de la misma transacción que el cambio, para: pedido recibido,
`en_camino`, `entregado`, `entrega_fallida`, `cancelado` y reprogramado. Un proceso de la API los envía (varias instancias
no se pisan; hasta 5 intentos con espera creciente). Solo reciben correo las cuentas cuyo correo se **confirmó con código**;
en modo demo (`EMAIL_VERIFICATION_REQUIRED=false`) o con correos ficticios el aviso se omite.

### Compatibilidad con lo que ya existe

- `/orders`, `/delivery-orders`, `/routes` y el resto no cambian de forma. Un pedido puede ahora aparecer con `estado`
  `cancelado` o `entrega_fallida`; un frontend que muestre el estado como texto o color debe tener un valor por defecto.
- Un pedido **de tienda** ya no se puede marcar `entregado` por el endpoint genérico de estado sin registrar el cobro
  (`409 COLLECTION_REQUIRED`): el conductor debe usar `POST /store/courier/orders/:id/deliver`. Los pedidos normales
  (`POST /orders`) se entregan igual que antes y no tienen cobro.
- Cualquier ruta nueva de `/store` se niega por defecto a quien no tenga el rol correspondiente.

## Mapa y coordenadas (migración 013)

La dirección de entrega se puede elegir **en un mapa (pin)** o **escribir a mano**. El backend solo guarda el punto; el mapa lo dibuja el
frontend. Las coordenadas son **opcionales**: un pedido o una dirección sin ellas sigue siendo válido.

### Qué enviar

| Dónde | Campos nuevos | Notas |
| --- | --- | --- |
| `POST /store/orders` | `latitude`, `longitude` (números) | **Obligatorios.** Junto a `deliveryAddress`. Ver «Regla de entrega» abajo. |
| `POST /store/addresses` | `latitude`, `longitude` | Obligatorios. |
| `PATCH /store/addresses/:id` | `latitude`, `longitude` | Las dos juntas, siempre con valores: no se puede quitar el pin (`null` responde `422 PIN_REQUIRED`). Con una sola, `400`. |

### Regla de entrega (la decide el servidor)

Un pedido o una dirección guardada solo es válido si la zona **tiene cobertura** y el punto del mapa **cae dentro de ella**. Se comprueba antes de reservar stock o franja, así que un rechazo no consume nada. Al editar una dirección se juzga el resultado final (lo guardado más el cambio).

| Código | HTTP | Cuándo |
|---|---|---|
| `ZONE_NOT_OPERATIONAL` | 422 | La zona existe pero aún no tiene cobertura definida: no recibe pedidos. |
| `PIN_REQUIRED` | 422 | Falta el punto del mapa. |
| `ZONE_OUT_OF_COVERAGE` | 422 | El punto cae fuera de la cobertura de esa zona. |

Una zona inexistente sigue respondiendo `404 ZONE_NOT_FOUND` y una inactiva `409` con `details.reason = zone_inactive`. Los pedidos del administrador (`POST /orders`) exigen que la zona tenga cobertura (`409`); no llevan pin.

Reglas (`400 VALIDATION_ERROR` si no se cumplen): las dos coordenadas juntas o ninguna; deben ser números; deben caer dentro de Ecuador
(latitud −5.1 a 1.5 y longitud −92.5 a −75.0, incluye Galápagos), para atrapar pines mal puestos. La misma `Idempotency-Key` con otro pin
responde `422 IDEMPOTENCY_KEY_REUSED`, igual que con otro producto o dirección.

### Qué se recibe

- Pedidos (`GET /store/orders`, `/store/orders/:id`, `/store/admin/orders`): `deliveryLatitude` y `deliveryLongitude` (`null` si fue manual).
- Direcciones: `latitude` y `longitude`.
- Conductor (`GET /store/courier/orders`): `deliveryLatitude` y `deliveryLongitude` de cada parada, para mostrar el destino en su mapa o abrir la
  navegación: `https://www.openstreetmap.org/directions?to=<lat>,<lng>` o `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`.

### Cómo dibujar el mapa (proveedor gratuito: OpenStreetMap)

No se necesita clave ni tarjeta. Ejemplo mínimo con Leaflet (web):

```js
const map = L.map('mapa').setView([-0.1807, -78.4678], 13);               // Quito
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
const pin = L.marker([-0.1807, -78.4678], { draggable: true }).addTo(map);
pin.on('dragend', async () => {
  const { lat, lng } = pin.getLatLng();
  // Dirección legible a partir del pin (geocodificación inversa de Nominatim):
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=es`);
  const place = await r.json();     // place.display_name → rellena el campo de dirección
  // Al comprar: { deliveryAddress, latitude: lat, longitude: lng, ... }
});
```

- **Buscar escribiendo:** `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=ec&q=<texto>`. Política de uso de Nominatim: máximo **1 petición por segundo**,
  con espera de ~500 ms entre teclas, sin autocompletar a cada letra y con una cabecera `Referer` o `User-Agent` propia. Para producción con mucho tráfico conviene un
  geocodificador propio o de pago; el backend no cambia, porque solo guarda `latitude` y `longitude`.
- **Texto de la dirección:** `deliveryAddress` sigue validándose con la lista blanca de caracteres (letras, números y puntuación básica, sin emojis). El
  texto que devuelve Nominatim (`display_name`) puede traer caracteres que no pasen; límpialo antes de enviarlo o deja que la persona lo edite.
- **Modo manual:** si la persona rellena el formulario sin mapa, se envía lo mismo sin `latitude`/`longitude`.

## Alcance actual y lo que no incluye

Incluido: catálogo, búsqueda y filtros, ofertas, administración con historial, stock con libro de movimientos,
franjas de entrega con cupo, pedido atómico e idempotente, imágenes en disco o Supabase Storage, cancelación con
devolución de stock, entrega fallida con reprogramación (3 intentos), cobro contra entrega, rendición de caja, libreta de
direcciones, reportes del administrador y avisos por correo.

**No incluido** (fuera del alcance del proyecto simulado): pago en línea (el único método es `contra_entrega`), varios
vendedores, reseñas, cupones, devoluciones posteriores a la entrega y notificaciones push.

## Qué debe hacer el frontend

1. **Carrito en el navegador** (por ejemplo `localStorage`), guardando `productId`, `quantity` y el `priceCents` visto.
   Al abrirlo o antes de pagar, vuelve a pedir los productos (`GET /store/products/:id`) para detectar precios, stock o
   disponibilidad distintos.
2. **Franja:** pide `delivery-slots` al elegir zona y fecha; deshabilita las que tengan `available: false`.
3. **Pagar:** genera una `Idempotency-Key` (UUID) al abrir la pantalla de pago, deshabilita el botón al hacer clic y, si la
   conexión falla, reintenta **con la misma clave**. Si responde `409 ORDER_CONFLICT`, muestra el detalle, actualiza el carrito
   y genera una clave nueva para el siguiente intento.
4. **Errores:** `400` muestra el `message`; `401` lleva al inicio de sesión; `403` oculta la acción; `409 VERSION_CONFLICT` o `STALE_ORDER` piden recargar;
   `429` pide esperar; `503` permite reintentar.
5. Al subir una imagen, actualiza la `version` con la de la respuesta (la imagen incrementa la versión del producto).

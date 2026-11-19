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

## Alcance actual y lo que no incluye

Incluido: catálogo, búsqueda y filtros, ofertas, administración con historial, stock con libro de movimientos,
franjas de entrega con cupo, pedido atómico e idempotente, imágenes en disco o Supabase Storage.

**No incluido todavía** (a propósito, para no afectar al frontend actual):

- **Cancelar un pedido de tienda y devolver el stock.** El estado `cancelado` no existe en el ciclo de entrega y los lectores
  de respuesta del frontend de entregas y repartidores no lo conocen. Es el siguiente paso natural; requerirá un estado
  nuevo, una función SQL que devuelva el stock una sola vez y que el frontend lo reconozca.
- Pago en línea (el único método es `contra_entrega`), varios vendedores, reseñas, cupones y devoluciones.

## Qué debe hacer el frontend

1. **Carrito en el navegador** (por ejemplo `localStorage`), guardando `productId`, `quantity` y el `priceCents` visto.
   Al abrirlo o antes de pagar, vuelve a pedir los productos (`GET /store/products/:id`) para detectar precios, stock o
   disponibilidad distintos.
2. **Franja:** pide `delivery-slots` al elegir zona y fecha; deshabilita las que tengan `available: false`.
3. **Pagar:** genera una `Idempotency-Key` (UUID) al abrir la pantalla de pago, deshabilita el botón al hacer clic y, si la
   conexión falla, reintenta **con la misma clave**. Si responde `409 ORDER_CONFLICT`, muestra el detalle, actualiza el carrito
   y genera una clave nueva para el siguiente intento.
4. **Errores:** `400` muestra el `message`; `401` lleva al inicio de sesión; `409 VERSION_CONFLICT` pide recargar;
   `429` pide esperar; `503` permite reintentar.
5. Al subir una imagen, actualiza la `version` con la de la respuesta (la imagen incrementa la versión del producto).

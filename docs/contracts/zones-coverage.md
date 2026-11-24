# Cobertura de zonas (migración 015)

Cada zona puede tener un **centro** (latitud y longitud dentro de Ecuador) y un **radio** en km. Con eso el sistema sabe
a qué zona pertenece un punto del mapa y el cliente ya no tiene que elegir la zona a mano. Una zona sin cobertura sigue
funcionando como antes.

## Reglas de las zonas

- **Nombre:** de 3 a 40 caracteres, al menos 3 letras, **único** sin importar mayúsculas ni espacios (`409 DATA_CONFLICT`; también lo garantiza un índice en la base, migración 018). El texto no puede saber si el nombre «tiene sentido»: lo que da realidad a una zona es su cobertura.
- **Una zona sin cobertura no es operativa:** no recibe pedidos ni direcciones. Ver «Regla de entrega» en `store.md`.

## Rutas: límites al planificar

`POST /route-plans` y `POST /late-order-placements` (solo al crear; las rutas ya guardadas no se revalidan):

- `capacityLimit`: entero de 1 a **20**.
- `serviceDate` (solo planificación): desde **hoy** hasta **60 días** adelante, en hora de Ecuador. Una fecha pasada o más lejana responde `400 VALIDATION_ERROR`.

## Objeto zona

Toda respuesta de zona incluye `coverage` (`null` si no tiene):

```json
{ "id": "…", "name": "Izamba", "createdAt": "…", "updatedAt": "…",
  "coverage": { "latitude": -1.21, "longitude": -78.599, "radiusKm": 3 } }
```

## `PUT /zones/:id/coverage` (solo `personal`)

Cuerpo: `{ "coverage": { "latitude", "longitude", "radiusKm" } }` o `{ "coverage": null }` para quitarla.

- `latitude`/`longitude`: números dentro de Ecuador (incluye Galápagos).
- `radiusKm`: de 0,1 a 50 (se guarda con 2 decimales).
- `200` con la zona; `400 VALIDATION_ERROR` si algo no cumple o hay campos de más; `404 ZONE_NOT_FOUND`.

## `GET /zones/lookup?latitude=&longitude=` (cualquier rol con sesión)

Devuelve la zona **activa** que cubre el punto: `200 { "zone": Zone }`, o `200 { "zone": null }` si ninguna lo cubre
(el frontend muestra "Aún no llegamos a esta dirección"). Si dos zonas se solapan, gana la de centro más cercano.
`400 VALIDATION_ERROR` si falta un valor, no es número o el punto está fuera de Ecuador.

## Cómo usarlo en el pago

1. El cliente marca el punto en el mapa (o elige una dirección guardada con coordenadas).
2. El frontend llama a `/zones/lookup` y usa `zone.id` para pedir las franjas (`/store/delivery-slots`) y crear el pedido.
3. Si `zone` es `null`, no se puede pedir a ese punto.

La distancia es de gran círculo (haversine), calculada en la base sin PostGIS.

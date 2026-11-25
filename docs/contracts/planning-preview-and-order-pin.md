# Vista previa de la planificación y pin del pedido del administrador (migración 020)

## `GET /route-plans/preview?serviceDate=YYYY-MM-DD&capacityLimit=N` (solo `personal`)

Dice, **sin crear ni cambiar nada**, qué haría `POST /route-plans` con esos mismos datos. Aplica los mismos límites que el plan:
fecha de hoy a +60 días y capacidad de 1 a 20; si no se cumplen, `400 VALIDATION_ERROR`.

```json
{
  "serviceDate": "2026-11-25",
  "capacityLimit": 4,
  "zones": [
    { "zoneId": "…", "zoneName": "Ambato Centro", "orders": 5, "routes": 2, "routeSizes": [4, 1] }
  ],
  "totalOrders": 5,
  "totalRoutes": 2,
  "availableCouriers": 1
}
```

- Solo cuentan las zonas **activas** y los pedidos **pendientes** de esa fecha; las rutas se llenan de a `capacityLimit`
  en orden de hora, igual que `generate_routes`. La prueba SQL compara la vista previa con el plan real.
- `routeSizes`: tamaño de cada ruta que se crearía. `availableCouriers`: repartidores habilitados y disponibles sin ruta
  asignada ni en curso (informativo: la asignación sigue siendo un paso aparte).
- Una zona con pedidos pendientes no puede desactivarse (migración 019), así que ningún pedido pendiente queda fuera del plan.

## Pin en `POST /orders` (solo `personal`)

El cuerpo acepta, opcionales, `latitude` y `longitude` (números). Reglas:

- Van **juntas** (las dos o ninguna) y dentro de Ecuador; si no, `400 VALIDATION_ERROR`. Un texto en lugar de número también es `400`.
- Con pin, el punto debe caer **dentro de la cobertura de la zona elegida**: si no, `422 ZONE_OUT_OF_COVERAGE` y no se crea nada
  (la misma regla y el mismo código que en la tienda).
- Sin pin el pedido se crea como siempre (`latitude` y `longitude` quedan en `null`). Toda respuesta de pedido incluye ambos campos.
- Un `cliente` no puede enviar pin por esta ruta (`400`); sus pedidos con ubicación se hacen desde `/store`.

## Efecto en las rutas

El orden de paradas por vecino mas cercano (`zona_hora_nn_v2`), el pedido tardío y el puntaje del conductor usan el pin del pedido
cuando no es un pedido de tienda. Sin pin, la distancia cuenta 0 y manda la hora, como antes.

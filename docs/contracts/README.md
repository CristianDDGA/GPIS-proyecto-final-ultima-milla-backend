# Contrato HTTP de la API

`openapi.yaml` es la fuente canónica del contrato de la API unificada (versión `0.2.0`): Zonas y Pedidos (Sprint 01), Rutas y Repartidores (Sprint 02). Los archivos de `sprint-02/` se conservan como historial de cada entrega; sus paths ya están incluidos en `openapi.yaml`, y los componentes con el mismo nombre pero distinta definición llevan el prefijo del módulo (`Courier*`, `Routes*`).

Definición original del Sprint 01: Cristian mantiene esta definición; Jhon revisa Zonas y Alexis revisa el consumo web. La versión inicial es `0.1.0`, propuesta para revisión del equipo.

## Uso desde frontend

1. Revisar las operaciones, entradas, respuestas y errores en `openapi.yaml`.
2. Al aprobar el cambio, copiar ese archivo al repositorio frontend en `docs/contracts/openapi.yaml`.
3. Registrar en el `version.json` de frontend la versión, el commit real de backend y el SHA-256 del archivo copiado. No registrar el commit base como si incluyera cambios todavía sin commit.
4. Configurar `VITE_API_BASE_URL` para el backend acordado. No importar código de este clon ni entregar credenciales de base de datos al navegador.

Los cambios de contrato se coordinan mediante PR relacionados. No se crea otro contrato para pedidos.

## Decisiones HTTP

- Rutas: `/health`, `/zones`, `/zones/{id}`, `/orders`, `/orders/{id}`, `/route-plans`, `/routes`, `/routes/{id}`, `/couriers`, `/couriers/{id}/availability`, `/couriers/{id}/route` y `/courier-assignments`.
- Una ruta inexistente responde `404 / NOT_FOUND`, y el JSON mal formado responde `400 / VALIDATION_ERROR` en cualquier ruta, siempre con el mismo sobre.
- CORS permite al origen web las cabeceras `Content-Type`, `Authorization` e `Idempotency-Key`.
- Alta: `201`. Consulta: `200`; una lista sin coincidencias devuelve `{ "items": [] }`.
- Validación: `400 / VALIDATION_ERROR`; JSON mayor que 32 KB: `413 / VALIDATION_ERROR`.
- Ausencia: `404 / ZONE_NOT_FOUND` o `404 / ORDER_NOT_FOUND`.
- Conflicto, incluida zona explícitamente inactiva: `409 / DATA_CONFLICT`.
- Fallo técnico de persistencia: `503 / PERSISTENCE_UNAVAILABLE`; error inesperado de aplicación: `500 / INTERNAL_SERVER_ERROR`.
- Se conserva `{ code, message, error: { code, message } }` para compatibilidad con Jhon; ambos niveles contienen los mismos valores.
- Registro recibe únicamente `zoneId`, `deliveryAddress`, `deliveryDate` y `deliveryTime`. Los campos adicionales se ignoran, incluidos identidad, estado y metadatos del cliente.
- El dominio normaliza espacios exteriores y UUID a minúsculas. Los filtros suministrados deben ser textos únicos válidos; vacíos y parámetros repetidos se rechazan.
- Entrega usa día `YYYY-MM-DD` y hora `HH:mm` de `America/Guayaquil`. No convertir estos valores a UTC. Creación y actualización son instantes UTC generados por persistencia. La función SQL original rechaza altas con fecha pasada; el backend conserva esa regla técnica y responde `400 / VALIDATION_ERROR`. Los filtros pueden consultar fechas históricas.
- Los filtros de fecha y zona se combinan con AND y se aplican a entrega.

## Disponibilidad

Con `DATABASE_URL`, `server.ts` conecta el cliente Prisma único y `create-persisted-app.ts` monta todos los módulos en el mismo servidor (puerto `PORT`, 3000 por defecto): zonas, pedidos, rutas y repartidores. Los servidores autónomos de `src/bootstrap/sprint02/` (3011 y 3012) se conservan solo para reproducir las entregas del Sprint 02. La API usa `logistica_app` y las funciones originales. Sin URL solo habilita `/health`. `createApp` permite inyectar Orders y su consulta de zonas por separado.

No se habilita almacenamiento en memoria como base de datos del servidor. `npm run test:integration:postgres` ejecuta los mismos casos HTTP con PostgreSQL real en un contenedor temporal; el modo en memoria se conserva como regresión.

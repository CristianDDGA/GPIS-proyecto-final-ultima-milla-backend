/**
 * Regla de negocio compartida por pedidos y direcciones: una entrega solo es válida si su zona está definida en el
 * mapa y el punto de entrega cae dentro de ella. La implementa el módulo de zonas; los demás módulos solo ven este
 * puerto y deciden cómo responder (cada uno con su propio error HTTP).
 */

/** Punto de entrega marcado en el mapa; `null` en ambos si la persona no lo marcó. */
export interface DeliveryPoint {
  readonly latitude: number | null;
  readonly longitude: number | null;
}

/**
 * Motivo por el que la entrega no es válida:
 * - ZONE_NOT_OPERATIONAL: la zona aún no tiene cobertura definida, así que no recibe pedidos.
 * - PIN_REQUIRED: falta el punto del mapa.
 * - ZONE_OUT_OF_COVERAGE: el punto cae fuera de la cobertura de esa zona.
 */
export type DeliveryZoneIssue = 'ZONE_NOT_OPERATIONAL' | 'PIN_REQUIRED' | 'ZONE_OUT_OF_COVERAGE';

export interface ZoneDeliveryGuard {
  /**
   * `null` si la entrega es válida. Una zona inexistente o inactiva tampoco se juzga aquí (devuelve `null`): de eso
   * ya responde la capa de pedidos con su propio error.
   */
  check(zoneId: string, point: DeliveryPoint): Promise<DeliveryZoneIssue | null>;
}

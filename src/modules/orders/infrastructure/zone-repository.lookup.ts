import type { OrderZonePort } from '../application/ports/order-zone.port.js';

/** Lo mínimo que se necesita de una zona: su identidad y si tiene cobertura definida en el mapa. */
export interface ZoneSource {
  findById(id: string): Promise<{ readonly id: string; readonly coverage: unknown } | null>;
}

/** Adapta un repositorio de zonas al puerto del módulo de pedidos (existencia y cobertura de la zona). */
export function orderZonePortFrom(zones: ZoneSource): OrderZonePort {
  return {
    async findById(id) {
      const zone = await zones.findById(id);
      return zone === null ? null : { id: zone.id, hasCoverage: zone.coverage !== null && zone.coverage !== undefined };
    },
  };
}

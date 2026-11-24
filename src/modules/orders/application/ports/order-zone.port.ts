export interface OrderZonePort {
  /**
   * `active`: Zones has no lifecycle in every adapter, so it may be absent.
   * `hasCoverage`: una zona sin cobertura definida en el mapa no es operativa y no recibe pedidos.
   */
  findById(id: string): Promise<{ readonly id: string; readonly active?: boolean; readonly hasCoverage: boolean } | null>;
}

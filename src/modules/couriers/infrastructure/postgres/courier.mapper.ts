import type { Courier } from '../../domain/courier.js';
export interface CourierRecord {
  id: string; display_name: string; max_orders_per_trip: number;
  is_enabled: boolean; is_available: boolean; created_at: Date; updated_at: Date;
}
export function mapCourier(row: CourierRecord): Courier {
  return { id: row.id, displayName: row.display_name, maxOrdersPerTrip: row.max_orders_per_trip,
    isEnabled: row.is_enabled, isAvailable: row.is_available, createdAt: row.created_at, updatedAt: row.updated_at };
}

import type { Courier } from '../../domain/courier.js';
export interface CourierPage { readonly available: boolean | undefined; readonly limit: number; readonly offset: number }
export interface CourierRepository {
  create(input: { readonly displayName: string; readonly maxOrdersPerTrip: number }): Promise<Courier>;
  list(page: CourierPage): Promise<readonly Courier[]>;
  setAvailability(id: string, available: boolean): Promise<Courier>;
}

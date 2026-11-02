import type { CourierRepository, CourierPage } from './ports/courier.repository.js';
import { validateId, validateRegistration } from '../domain/courier.js';
import { CourierError } from '../domain/courier.errors.js';
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new CourierError('VALIDATION_ERROR');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new CourierError('VALIDATION_ERROR');
  return result;
}
export class CourierUseCases {
  constructor(private readonly repository: CourierRepository) {}
  create(displayName: unknown, capacity: unknown) {
    return this.repository.create(validateRegistration(displayName, capacity));
  }
  async list(query: { available?: unknown; limit?: unknown; offset?: unknown }) {
    if (query.available !== undefined && query.available !== 'true' && query.available !== 'false') throw new CourierError('VALIDATION_ERROR');
    const page: CourierPage = {
      available: query.available === undefined ? undefined : query.available === 'true',
      limit: integer(query.limit, 25, 1, 100), offset: integer(query.offset, 0, 0, 2147483647),
    };
    return { items: await this.repository.list(page), limit: page.limit, offset: page.offset };
  }
  setAvailability(id: unknown, available: unknown) {
    const courierId = validateId(id);
    if (typeof available !== 'boolean') throw new CourierError('VALIDATION_ERROR');
    return this.repository.setAvailability(courierId, available);
  }
}

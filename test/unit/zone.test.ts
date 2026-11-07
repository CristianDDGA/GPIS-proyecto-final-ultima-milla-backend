import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Zone } from '../../src/modules/zones/domain/zone.entity.js';

const properties = {
  id: 'a0000000-0000-4000-8000-000000000001', name: ' Centro ',
  createdAt: new Date('2026-10-20T10:00:00.000Z'), updatedAt: new Date('2026-10-20T10:00:00.000Z'),
};

test('prepares only business data, leaving identity and timestamps to persistence', () => {
  assert.deepEqual(Zone.prepare({ name: ' Centro ' }), { name: 'Centro' });
  assert.throws(() => Zone.prepare({ name: ' ' }));
});
test('rehydration validates persisted dates', () => {
  assert.throws(() => Zone.create({ ...properties, createdAt: new Date('invalid') }));
  assert.throws(() => Zone.create({ ...properties, updatedAt: new Date('2026-10-19') }));
});
test('persisted dates cannot be mutated through inputs or getters', () => {
  const input = { ...properties, createdAt: new Date(properties.createdAt) };
  const zone = Zone.create(input);
  input.createdAt.setFullYear(2000);
  zone.updatedAt.setFullYear(2000);
  assert.equal(zone.toJSON().createdAt, '2026-10-20T10:00:00.000Z');
  assert.equal(zone.toJSON().updatedAt, '2026-10-20T10:00:00.000Z');
});

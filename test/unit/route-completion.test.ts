import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRouteCompletable } from '../../src/modules/deliveries/domain/delivery-order.js';

test('una ruta en curso con paradas entregadas se puede completar', () => {
  assert.doesNotThrow(() => assertRouteCompletable('en_curso', ['entregado', 'entregado']));
});

test('una parada con entrega fallida no impide completar la ruta', () => {
  assert.doesNotThrow(() => assertRouteCompletable('en_curso', ['entregado', 'entrega_fallida', 'entregado']));
  assert.doesNotThrow(() => assertRouteCompletable('en_curso', ['entrega_fallida']));
});

test('una parada pendiente, recogida o en camino sigue bloqueando la ruta', () => {
  for (const open of ['asignado_a_ruta', 'recogido', 'en_camino'] as const) {
    assert.throws(() => assertRouteCompletable('en_curso', ['entregado', open]), /entregados o con entrega fallida/, open);
  }
});

test('solo se completa una ruta en curso y con paradas activas', () => {
  assert.throws(() => assertRouteCompletable('asignada', ['entregado']), /en_curso/);
  assert.throws(() => assertRouteCompletable('completada', ['entregado']), /en_curso/);
  assert.throws(() => assertRouteCompletable('en_curso', []), /no tiene paradas activas/);
});

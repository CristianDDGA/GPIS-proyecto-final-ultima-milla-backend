import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedWebOrigins } from '../../src/bootstrap/create-app.js';

test('CORS acepta localhost y 127.0.0.1 en el mismo puerto cuando WEB_ORIGIN es local', () => {
  assert.deepEqual([...allowedWebOrigins('http://127.0.0.1:5173')], ['http://127.0.0.1:5173', 'http://localhost:5173']);
  assert.deepEqual([...allowedWebOrigins('http://localhost:5173')], ['http://localhost:5173', 'http://127.0.0.1:5173']);
});

test('CORS no agrega orígenes extra para un dominio público', () => {
  assert.deepEqual([...allowedWebOrigins('https://millast.example.com')], ['https://millast.example.com']);
});

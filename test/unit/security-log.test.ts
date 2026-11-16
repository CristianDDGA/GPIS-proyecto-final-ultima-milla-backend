import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail } from '../../src/modules/auth/application/ports/security-log.port.js';
import { createJsonSecurityLog } from '../../src/modules/auth/infrastructure/logging/json-security-log.js';

describe('registro de eventos de seguridad', () => {
  test('maskEmail oculta la parte local y conserva el dominio', () => {
    assert.equal(maskEmail('ana.perez@correo.com'), 'a***@correo.com');
    assert.equal(maskEmail('x@y.co'), 'x***@y.co');
    assert.equal(maskEmail('sin-arroba'), '***');
    assert.equal(maskEmail('@dominio.com'), '***');
  });

  test('el registro JSON escribe una línea por evento con fecha y canal', () => {
    const lines: string[] = [];
    const log = createJsonSecurityLog((line) => lines.push(line), () => new Date('2026-11-16T15:00:00.000Z'));
    log({ type: 'login_failed', email: 'a***@correo.com', userId: 'u-1', detail: 'wrong_password' });
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.endsWith('\n'));
    assert.deepEqual(JSON.parse(lines[0]!), {
      ts: '2026-11-16T15:00:00.000Z', channel: 'security', type: 'login_failed', email: 'a***@correo.com', userId: 'u-1', detail: 'wrong_password',
    });
  });

  test('si escribir falla, el registro no lanza', () => {
    const log = createJsonSecurityLog(() => { throw new Error('stdout cerrado'); });
    assert.doesNotThrow(() => log({ type: 'logout' }));
  });
});

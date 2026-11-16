import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { loadConfig } from '../../src/bootstrap/config.js';
import { buildCodeEmail } from '../../src/modules/auth/application/email-templates.js';
import { validateOneTimeCode } from '../../src/modules/auth/domain/auth-user.entity.js';
import { AuthError } from '../../src/modules/auth/domain/auth.errors.js';
import { deriveCodeKey, generateOneTimeCode, hashOneTimeCode } from '../../src/modules/auth/infrastructure/crypto/one-time-code.js';
import { InMemoryTokenRevocationStore } from '../../src/modules/auth/infrastructure/crypto/in-memory-token-revocation.store.js';
import { ConsoleEmailSender } from '../../src/modules/auth/infrastructure/email/console-email-sender.js';
import { SmtpEmailSender } from '../../src/modules/auth/infrastructure/email/smtp-email-sender.js';

const SECRET = 'unit-test-jwt-secret-abcdefghijklmnopqrstuvwxyz';

describe('códigos de un solo uso', () => {
  test('generateOneTimeCode produce siempre 6 dígitos y no repite en una muestra amplia', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 2000; index += 1) {
      const code = generateOneTimeCode();
      assert.match(code, /^\d{6}$/);
      seen.add(code);
    }
    assert.ok(seen.size > 1900, 'la distribución debe ser amplia');
  });

  test('el hash depende de la clave, el usuario, el propósito y el código; nunca contiene el código', () => {
    const key = deriveCodeKey(SECRET);
    const base = hashOneTimeCode(key, 'user-1', 'verify_email', '123456');
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(base, hashOneTimeCode(key, 'user-1', 'verify_email', '123456'));
    assert.notEqual(base, hashOneTimeCode(key, 'user-2', 'verify_email', '123456'));
    assert.notEqual(base, hashOneTimeCode(key, 'user-1', 'reset_password', '123456'));
    assert.notEqual(base, hashOneTimeCode(key, 'user-1', 'verify_email', '123457'));
    assert.notEqual(base, hashOneTimeCode(deriveCodeKey(`${SECRET}x`), 'user-1', 'verify_email', '123456'));
    assert.ok(!base.includes('123456'));
    assert.notEqual(key, SECRET);
  });

  test('validateOneTimeCode exige exactamente 6 dígitos', () => {
    assert.equal(validateOneTimeCode(' 012345 '), '012345');
    for (const invalid of ['12345', '1234567', '12345a', '١٢٣٤٥٦', '', undefined, 123456]) {
      assert.throws(() => validateOneTimeCode(invalid), (error: unknown) => error instanceof AuthError && error.code === 'VALIDATION_ERROR');
    }
  });
});

describe('plantilla del correo', () => {
  test('incluye el código, la caducidad y escapa el nombre del usuario', () => {
    const message = buildCodeEmail({ to: 'ana@test.com', purpose: 'verify_email', code: '042042', ttlMinutes: 15, displayName: '<b>Ana</b>' });
    assert.equal(message.to, 'ana@test.com');
    assert.match(message.subject, /042042/);
    assert.match(message.text, /Código: 042042/);
    assert.match(message.text, /15 minutos/);
    assert.ok(!message.html.includes('<b>Ana</b>'), 'el HTML debe escapar el nombre');
    assert.match(message.html, /&lt;b&gt;Ana&lt;\/b&gt;/);
  });

  test('el asunto distingue verificar correo de recuperar contraseña', () => {
    const verify = buildCodeEmail({ to: 'a@b.co', purpose: 'verify_email', code: '111111', ttlMinutes: 15, displayName: null });
    const reset = buildCodeEmail({ to: 'a@b.co', purpose: 'reset_password', code: '111111', ttlMinutes: 15, displayName: null });
    assert.match(verify.subject, /verificar/);
    assert.match(reset.subject, /recuperar/);
  });
});

describe('envío SMTP real contra un servidor local', () => {
  const received: string[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => { received.push(Buffer.concat(chunks).toString('utf8')); callback(); });
    },
  });
  const listening = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.server.address() as AddressInfo).port));
  });
  after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

  test('SmtpEmailSender entrega el correo con remitente, destinatario, texto y HTML', async () => {
    const port = await listening;
    const sender = new SmtpEmailSender({ host: '127.0.0.1', port, secure: false, from: 'Última Milla <no-reply@ultima-milla.test>' });
    await sender.send(buildCodeEmail({ to: 'ana@test.com', purpose: 'verify_email', code: '987654', ttlMinutes: 15, displayName: 'Ana Pérez' }));
    assert.equal(received.length, 1);
    const parsed = await simpleParser(received[0]!);
    assert.equal(parsed.to && !Array.isArray(parsed.to) ? parsed.to.text : '', 'ana@test.com');
    assert.match(parsed.from?.text ?? '', /no-reply@ultima-milla\.test/);
    assert.match(parsed.subject ?? '', /987654/);
    assert.match(parsed.text ?? '', /Código: 987654/);
    assert.match(String(parsed.html), /987654/);
  });

  test('si el SMTP no responde, send() rechaza en lugar de colgarse', async () => {
    const sender = new SmtpEmailSender({ host: '127.0.0.1', port: 1, secure: false, from: 'no-reply@ultima-milla.test' });
    await assert.rejects(() => sender.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h' }));
  });

  test('ConsoleEmailSender solo escribe en la salida que se le entrega', async () => {
    const lines: string[] = [];
    await new ConsoleEmailSender((line) => lines.push(line)).send({ to: 'a@b.co', subject: 'Asunto', text: 'Código: 111111', html: '' });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /a@b\.co/);
  });
});

describe('configuración de correo', () => {
  const base = { JWT_SECRET: SECRET } as NodeJS.ProcessEnv;

  test('por defecto la verificación está activa y los correos van a la consola', () => {
    const config = loadConfig(base);
    assert.equal(config.emailVerificationRequired, true);
    assert.deepEqual(config.mail, { transport: 'console' });
  });

  test('EMAIL_VERIFICATION_REQUIRED=false activa el modo demo y valida el valor', () => {
    assert.equal(loadConfig({ ...base, EMAIL_VERIFICATION_REQUIRED: 'false' }).emailVerificationRequired, false);
    assert.throws(() => loadConfig({ ...base, EMAIL_VERIFICATION_REQUIRED: 'quizás' }), /true o false/);
  });

  test('SMTP_HOST exige MAIL_FROM y deriva TLS implícito en el puerto 465', () => {
    assert.throws(() => loadConfig({ ...base, SMTP_HOST: 'smtp.ejemplo.com' }), /MAIL_FROM/);
    const config = loadConfig({ ...base, SMTP_HOST: 'smtp.resend.com', SMTP_PORT: '465', SMTP_USER: 'resend', SMTP_PASS: 'clave', MAIL_FROM: 'Última Milla <no-reply@ultima-milla.test>' });
    assert.deepEqual(config.mail, {
      transport: 'smtp',
      smtp: { host: 'smtp.resend.com', port: 465, secure: true, from: 'Última Milla <no-reply@ultima-milla.test>', user: 'resend', password: 'clave' },
    });
    assert.throws(() => loadConfig({ ...base, SMTP_HOST: 'smtp.ejemplo.com', MAIL_FROM: 'a@b.co', SMTP_PORT: '99999' }), /SMTP_PORT/);
  });

  test('en producción con verificación activa, SMTP es obligatorio; en modo demo no', () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /SMTP_HOST es obligatorio/);
    assert.doesNotThrow(() => loadConfig({ ...base, NODE_ENV: 'production', EMAIL_VERIFICATION_REQUIRED: 'false' }));
  });
});

describe('cierre de sesiones por usuario', () => {
  test('InMemoryTokenRevocationStore invalida solo los tokens emitidos antes del corte de ese usuario', async () => {
    const store = new InMemoryTokenRevocationStore();
    await store.revokeUserSessions('user-1', 1000);
    assert.equal(await store.isRevoked('jti-a', { sub: 'user-1', iat: 999 }), true);
    assert.equal(await store.isRevoked('jti-b', { sub: 'user-1', iat: 1000 }), false, 'emitido en el segundo del corte');
    assert.equal(await store.isRevoked('jti-c', { sub: 'user-1', iat: 1500 }), false);
    assert.equal(await store.isRevoked('jti-d', { sub: 'user-2', iat: 1 }), false, 'otro usuario no se ve afectado');
    assert.equal(await store.isRevoked('jti-e'), false, 'sin claims solo cuenta la revocación por jti');
  });
});

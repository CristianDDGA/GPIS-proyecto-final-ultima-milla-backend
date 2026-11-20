import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { AuthError } from '../../src/modules/auth/domain/auth.errors.js';
import { GoogleIdTokenVerifier, type GoogleKeySet } from '../../src/modules/auth/infrastructure/crypto/google-id-token-verifier.js';

const CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const nowSeconds = Math.floor(NOW / 1000);

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid, alg: 'RS256', use: 'sig' };
  return { jwk, privateKey };
}

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(privateKey: ReturnType<typeof keyPair>['privateKey'], claims: Record<string, unknown>, header: Record<string, unknown>): string {
  const body = `${b64(header)}.${b64(claims)}`;
  const signature = createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url');
  return `${body}.${signature}`;
}

const goodClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '110169484474386276334', email: 'ana@gmail.com', email_verified: true,
  name: 'Ana Pérez', iat: nowSeconds - 10, exp: nowSeconds + 3_000, ...overrides,
});

function setup(options: { keys?: GoogleKeySet; failFetch?: boolean } = {}) {
  const pair = keyPair('kid-1');
  let fetches = 0;
  let clock = NOW;
  const verifier = new GoogleIdTokenVerifier({
    clientId: CLIENT_ID,
    now: () => clock,
    fetchKeys: async () => {
      fetches += 1;
      if (options.failFetch) throw new Error('sin red');
      return options.keys ?? { keys: [pair.jwk], maxAgeSeconds: 3_600 };
    },
  });
  return { pair, verifier, fetches: () => fetches, advance: (ms: number) => { clock += ms; } };
}

const rejectsWith = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof AuthError && error.code === code);

test('un token firmado por Google, para nuestro Client ID y vigente, se acepta', async () => {
  const { pair, verifier } = setup();
  const identity = await verifier.verify(sign(pair.privateKey, goodClaims(), { alg: 'RS256', kid: 'kid-1', typ: 'JWT' }));
  assert.deepEqual(identity, { sub: '110169484474386276334', email: 'ana@gmail.com', emailVerified: true, name: 'Ana Pérez' });
});

test('acepta el emisor sin https y email_verified como texto "true"', async () => {
  const { pair, verifier } = setup();
  const identity = await verifier.verify(sign(pair.privateKey, goodClaims({ iss: 'accounts.google.com', email_verified: 'true' }), { alg: 'RS256', kid: 'kid-1' }));
  assert.equal(identity.emailVerified, true);
});

test('rechaza firma ajena, audiencia distinta, emisor falso y token caducado', async () => {
  const { pair, verifier } = setup();
  const header = { alg: 'RS256', kid: 'kid-1' };
  const stranger = keyPair('kid-1').privateKey; // misma kid, otra clave: la firma no coincide
  await rejectsWith(verifier.verify(sign(stranger, goodClaims(), header)), 'INVALID_GOOGLE_TOKEN');
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims({ aud: 'otra-app.apps.googleusercontent.com' }), header)), 'INVALID_GOOGLE_TOKEN');
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims({ iss: 'https://evil.example.com' }), header)), 'INVALID_GOOGLE_TOKEN');
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims({ exp: nowSeconds - 3_600 }), header)), 'INVALID_GOOGLE_TOKEN');
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims({ iat: nowSeconds + 3_600 }), header)), 'INVALID_GOOGLE_TOKEN');
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims({ sub: '' }), header)), 'INVALID_GOOGLE_TOKEN');
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims({ email: undefined }), header)), 'INVALID_GOOGLE_TOKEN');
});

test('rechaza algoritmos distintos de RS256 y tokens mal formados', async () => {
  const { pair, verifier } = setup();
  const unsigned = `${b64({ alg: 'none', kid: 'kid-1' })}.${b64(goodClaims())}.`;
  await rejectsWith(verifier.verify(unsigned), 'INVALID_GOOGLE_TOKEN');
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims(), { alg: 'HS256', kid: 'kid-1' })), 'INVALID_GOOGLE_TOKEN');
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims(), { alg: 'RS256' })), 'INVALID_GOOGLE_TOKEN');
  for (const garbage of ['', 'abc', 'a.b', 'a.b.c', 'x'.repeat(5000), '..']) {
    await rejectsWith(verifier.verify(garbage), 'INVALID_GOOGLE_TOKEN');
  }
});

test('guarda las claves en caché, y ante una clave desconocida vuelve a descargar como máximo una vez por minuto', async () => {
  const { pair, verifier, fetches, advance } = setup();
  const token = sign(pair.privateKey, goodClaims(), { alg: 'RS256', kid: 'kid-1' });
  await verifier.verify(token);
  await verifier.verify(token);
  assert.equal(fetches(), 1);

  const unknown = sign(pair.privateKey, goodClaims(), { alg: 'RS256', kid: 'kid-nueva' });
  advance(61_000);
  await rejectsWith(verifier.verify(unknown), 'INVALID_GOOGLE_TOKEN');
  assert.equal(fetches(), 2); // pasó más de un minuto desde la última descarga
  await rejectsWith(verifier.verify(unknown), 'INVALID_GOOGLE_TOKEN');
  assert.equal(fetches(), 2); // dentro del minuto no vuelve a descargar (un atacante no nos hace consultar a Google sin parar)
});

test('si no se pueden obtener las claves de Google el token no se acepta y el error es de servicio', async () => {
  const { pair, verifier } = setup({ failFetch: true });
  await rejectsWith(verifier.verify(sign(pair.privateKey, goodClaims(), { alg: 'RS256', kid: 'kid-1' })), 'PERSISTENCE_UNAVAILABLE');
});

test('exige un Client ID', () => {
  assert.throws(() => new GoogleIdTokenVerifier({ clientId: '  ' }));
});

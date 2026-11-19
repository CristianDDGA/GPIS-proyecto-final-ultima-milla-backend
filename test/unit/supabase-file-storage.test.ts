import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseFileStorage } from '../../src/infrastructure/storage/supabase-file-storage.js';

const KEY = `${'a1'.repeat(16)}.png`;
const SERVICE_KEY = 'service-role-key-secreta-de-prueba-0123456789';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeStorage(handler: (call: Call) => Response, bucket = 'product-images') {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  const storage = new SupabaseFileStorage({
    url: 'https://abcdefghijklmnop.supabase.co',
    serviceRoleKey: SERVICE_KEY,
    bucket,
    onError: () => new Error('storage'),
    fetchImpl,
  });
  return { storage, calls };
}

const headerOf = (call: Call, name: string): string | undefined => (call.init.headers as Record<string, string> | undefined)?.[name];

test('save: sube con la clave de servicio, sin sobrescribir y con el tipo según la extensión', async () => {
  const { storage, calls } = fakeStorage(() => new Response('{}', { status: 200 }));
  await storage.save(KEY, new Uint8Array([1, 2, 3]));
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.url, `https://abcdefghijklmnop.supabase.co/storage/v1/object/product-images/${KEY}`);
  assert.equal(call.init.method, 'POST');
  assert.equal(headerOf(call, 'Authorization'), `Bearer ${SERVICE_KEY}`);
  assert.equal(headerOf(call, 'apikey'), SERVICE_KEY);
  assert.equal(headerOf(call, 'x-upsert'), 'false');
  assert.equal(headerOf(call, 'Content-Type'), 'image/png');
  assert.equal(call.init.redirect, 'error');
});

test('save: usa image/jpeg para .jpg', async () => {
  const { storage, calls } = fakeStorage(() => new Response('{}', { status: 200 }));
  await storage.save(`${'b2'.repeat(16)}.jpg`, new Uint8Array([1]));
  assert.equal(headerOf(calls[0] as Call, 'Content-Type'), 'image/jpeg');
});

test('save: un fallo del proveedor sale como el error configurado, sin detalles ni la clave', async () => {
  const { storage } = fakeStorage(() => new Response(`{"error":"Duplicate","message":"${SERVICE_KEY}"}`, { status: 409 }));
  await assert.rejects(() => storage.save(KEY, new Uint8Array([1])), (error: Error) => {
    assert.equal(error.message, 'storage');
    assert.equal(JSON.stringify(error).includes(SERVICE_KEY), false);
    return true;
  });
});

test('save: una caída de red o un tiempo agotado también sale como el error configurado', async () => {
  const storage = new SupabaseFileStorage({
    url: 'https://abcdefghijklmnop.supabase.co',
    serviceRoleKey: SERVICE_KEY,
    bucket: 'product-images',
    onError: () => new Error('storage'),
    fetchImpl: (async () => { throw new TypeError('fetch failed: ECONNREFUSED'); }) as typeof fetch,
  });
  await assert.rejects(() => storage.save(KEY, new Uint8Array([1])), /storage/);
  await assert.rejects(() => storage.read(KEY), /storage/);
  await assert.rejects(() => storage.delete(KEY), /storage/);
});

test('solo acepta nombres generados por el servidor: bloquea rutas relativas y nombres ajenos', async () => {
  const { storage, calls } = fakeStorage(() => new Response('{}', { status: 200 }));
  for (const bad of ['../secreto.png', 'a/b.png', `${'a1'.repeat(16)}.gif`, 'SHORT.png', `${'A1'.repeat(16)}.png`, '', `${'a1'.repeat(16)}.png/../x`]) {
    await assert.rejects(() => storage.save(bad, new Uint8Array([1])), /storage/, bad);
    await assert.rejects(() => storage.read(bad), /storage/, bad);
    await assert.rejects(() => storage.delete(bad), /storage/, bad);
    assert.throws(() => storage.publicUrl(bad), /storage/, bad);
  }
  assert.equal(calls.length, 0);
});

test('read: devuelve los bytes; 404 es null; otros errores fallan', async () => {
  const { storage } = fakeStorage((call) => {
    if (call.url.endsWith(KEY)) return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  assert.deepEqual(await storage.read(KEY), new Uint8Array([9, 8, 7]));
  assert.equal(await storage.read(`${'c3'.repeat(16)}.png`), null);

  const bad = fakeStorage(() => new Response('boom', { status: 500 })).storage;
  await assert.rejects(() => bad.read(KEY), /storage/);
});

test('read: algunas versiones de Storage responden 400 con statusCode 404 cuando el objeto no existe', async () => {
  const { storage } = fakeStorage(() => new Response('{"statusCode":"404","error":"not_found","message":"Object not found"}', { status: 400 }));
  assert.equal(await storage.read(KEY), null);
});

test('delete: borrar algo que ya no existe no es un error', async () => {
  assert.equal(await fakeStorage(() => new Response('{}', { status: 404 })).storage.delete(KEY), undefined);
  assert.equal(await fakeStorage(() => new Response('{}', { status: 200 })).storage.delete(KEY), undefined);
  await assert.rejects(() => fakeStorage(() => new Response('{}', { status: 500 })).storage.delete(KEY), /storage/);
});

test('publicUrl apunta al bucket público y usa el bucket configurado', () => {
  const { storage } = fakeStorage(() => new Response('{}'), 'product-images');
  assert.equal(storage.publicUrl(KEY), `https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-images/${KEY}`);
  const other = fakeStorage(() => new Response('{}'), 'courier-applications').storage;
  assert.ok(other.publicUrl(KEY).includes('/courier-applications/'));
});

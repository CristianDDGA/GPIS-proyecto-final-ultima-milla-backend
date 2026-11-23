import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hashPassword, loadCanonicalMigrations, readZip } from '../../scripts/supabase/lib.mjs';
import { ScryptPasswordHasher } from '../../src/modules/auth/infrastructure/crypto/scrypt-password-hasher.js';

const ZIP = new URL('../../.ci/database-package.zip', import.meta.url);
const MANIFEST = new URL('../../.ci/database-package.json', import.meta.url);

test('el paquete canónico trae todas las migraciones en orden y con su checksum', () => {
  const migrations = loadCanonicalMigrations(ZIP, MANIFEST);
  assert.deepEqual(
    migrations.map((migration) => migration.name.slice(0, 3)),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015'],
  );
  for (const migration of migrations) {
    assert.equal(migration.checksum, createHash('sha256').update(migration.sql).digest('hex'));
    assert.ok(!/^\\/m.test(migration.sql), `${migration.name} no debe usar meta-comandos de psql`);
  }
});

test('el ZIP incluye las pruebas SQL y los scripts del paquete', () => {
  const files = readZip(readFileSync(ZIP));
  for (const name of ['database/tests/flows.sql', 'database/tests/store.sql', 'database/scripts/migrate.sh']) {
    assert.ok(files.has(name), `falta ${name}`);
  }
});

test('un paquete alterado o un manifiesto distinto se rechazan', () => {
  const real = readFileSync(MANIFEST, 'utf8');
  const manifest = JSON.parse(real) as { sha256: string };
  assert.ok(manifest.sha256.length === 64);
  assert.throws(() => loadCanonicalMigrations(MANIFEST, MANIFEST), /ZIP|manifiesto|JSON/);
  assert.throws(() => readZip(Buffer.from('esto no es un zip')), /ZIP/);
});

test('el hash del script de administrador lo verifica la API', async () => {
  const hash = await hashPassword('Clave-Segura-2030!');
  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  const hasher = new ScryptPasswordHasher();
  assert.equal(await hasher.verify('Clave-Segura-2030!', hash), true);
  assert.equal(await hasher.verify('otra-clave-distinta', hash), false);
  assert.notEqual(hash, await hashPassword('Clave-Segura-2030!'));
});

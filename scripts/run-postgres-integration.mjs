import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { URL } from 'node:url';
import { verifyDatabasePackage } from './verify-database-package.mjs';

const packagePath = process.env.DATABASE_PACKAGE_DIR;
verifyDatabasePackage(packagePath);
const manifest = JSON.parse(readFileSync(new URL('../.ci/database-package.json', import.meta.url), 'utf8'));
process.env.POSTGRES_IMAGE ??= manifest.postgresImage;
if (!/@sha256:[a-f0-9]{64}$/.test(process.env.POSTGRES_IMAGE)) {
  throw new Error('POSTGRES_IMAGE debe identificar una imagen inmutable por digest SHA-256.');
}
const project = `logistica_api_${process.pid}_${Date.now()}`;
const temp = mkdtempSync(join(tmpdir(), 'logistica-api-'));
const override = join(temp, 'ports.yaml');
writeFileSync(override, 'services:\n  postgres:\n    ports:\n      - "127.0.0.1::5432"\n');
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const args = ['compose','-p',project,'-f',resolve(packagePath,'compose.test.yaml'),'-f',override];
function run(command, commandArgs, capture = false, env = process.env, timeout = 180_000) {
  const result = spawnSync(command,commandArgs,{stdio:capture?'pipe':'inherit',encoding:'utf8',env,timeout});
  if (result.error || result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? '');
    throw new Error(`Falló ${command}; código ${result.status ?? 'sin salida'}.`);
  }
  return result.stdout?.trim();
}
let started = false;
try {
  // Original image, init, migrations, roles and SQL tests; only publish a temporary host port.
  started = true;
  run(docker,[...args,'up','-d','--wait','postgres']);
  // The original concurrency runner opens new admin sessions; choose their schema per session.
  run(docker,[...args,'run','--rm','-e','PGOPTIONS=-csearch_path=logistica,pg_catalog','tests']);
  const address = run(docker,[...args,'port','postgres','5432'],true);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address ?? '');
  if (!match) throw new Error('La base de pruebas debe publicar únicamente localhost.');
  const container = run(docker,[...args,'ps','-q','postgres'],true);
  const env = {
    ...process.env,
    TEST_DATABASE_URL:`postgresql://logistica_app:app_test_only@127.0.0.1:${match[1]}/logistica_test`,
    TEST_DATABASE_CONTAINER:container,
    TEST_DATABASE_PROJECT:project,
  };
  const delimiter = process.argv.indexOf('--');
  if (delimiter >= 0) {
    const [command, ...commandArgs] = process.argv.slice(delimiter + 1);
    if (!command) throw new Error('Falta el comando consumidor del ambiente PostgreSQL.');
    run(command, commandArgs, false, env, 600_000);
  } else {
    mkdirSync('reports', { recursive: true });
    run(process.execPath,['--experimental-vm-modules','node_modules/jest/bin/jest.js','--config','jest.integration.config.js','--runInBand','--json','--outputFile','reports/postgres.json'],false,env);
  }
} finally {
  try {
    if (started) run(docker,[...args,'down']);
  } finally {
    unlinkSync(override);
    rmdirSync(temp);
  }
}

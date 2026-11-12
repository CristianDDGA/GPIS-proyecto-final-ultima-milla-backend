// Escaneo DAST: OWASP ZAP Baseline contra la API unificada (puerto 3000).
// Uso: npm run test:security:zap
// Levanta PostgreSQL efimero con el paquete canonico (scripts/run-postgres-integration.mjs),
// arranca la API en :3000, ejecuta ZAP (Docker) y deja el reporte en reports/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..', '..');
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const image = process.env.ZAP_IMAGE ?? 'ghcr.io/zaproxy/zaproxy:stable';
const port = process.env.PORT ?? '3000';
const reportsDir = resolve(root, 'reports');
const securityDir = resolve(root, 'test', 'security');

async function waitForHealth(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try { if ((await globalThis.fetch(url)).ok) return; } catch { /* aun no escucha */ }
    await delay(1000);
  }
  throw new Error(`La API no respondio en ${url}.`);
}

async function inner() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Falta TEST_DATABASE_URL (use npm run test:security:zap).');
  mkdirSync(reportsDir, { recursive: true });
  const api = spawn(process.execPath, ['--import=tsx', 'src/bootstrap/server.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: port, DATABASE_URL: databaseUrl },
  });
  const apiExited = new Promise((_, reject) => api.once('exit', (code) => reject(new Error(`La API termino antes del escaneo (codigo ${code}).`))));
  apiExited.catch(() => {});
  const container = `zap-baseline-${process.pid}`;
  const cleanup = () => { api.kill(); spawnSync(docker, ['rm', '-f', container], { stdio: 'ignore' }); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });
  try {
    await Promise.race([waitForHealth(`http://127.0.0.1:${port}/health`), apiExited]);
    // host.docker.internal permite al contenedor alcanzar la API del host (Windows/macOS/Linux con --add-host).
    const target = `http://host.docker.internal:${port}`;
    const result = spawnSync(docker, [
      'run', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway',
      '-v', `${reportsDir}:/zap/wrk:rw`,
      '-v', `${securityDir}:/zap/security:ro`,
      image, 'zap-baseline.py',
      '-t', target,
      '-c', '/zap/security/zap-baseline.conf',
      '--hook=/zap/security/zap-hooks.py',
      '-r', 'zap-security-report.html',
      '-J', 'zap-security-report.json',
      '-m', '2', '-I',
    ], { stdio: 'inherit', cwd: root });
    // Con -I las advertencias no fallan; solo los FAIL del .conf o errores de ZAP.
    if (result.status !== 0) throw new Error(`ZAP finalizo con codigo ${result.status}. ${result.error?.message ?? ''}`);
    process.stdout.write('\nReporte: reports/zap-security-report.html y reports/zap-security-report.json\n');
  } finally {
    cleanup();
  }
}

if (process.argv.includes('--inner')) {
  await inner();
} else {
  process.env.DATABASE_PACKAGE_DIR ??= resolve(root, '..', 'db-proyecto');
  if (!existsSync(process.env.DATABASE_PACKAGE_DIR)) throw new Error('DATABASE_PACKAGE_DIR no existe.');
  const run = spawnSync(process.execPath, [
    resolve(root, 'scripts', 'run-postgres-integration.mjs'),
    '--', process.execPath, resolve(import.meta.filename), '--inner',
  ], { stdio: 'inherit', cwd: root, env: process.env });
  process.exit(run.status ?? 1);
}

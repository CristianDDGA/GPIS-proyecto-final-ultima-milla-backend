import { URL } from 'node:url';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(readFileSync(new URL('../.ci/database-package.json', import.meta.url), 'utf8'));
const bytes = readFileSync(new URL('../.ci/database-package.zip', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('El artefacto DB no coincide con su hash.');
process.stdout.write(`Paquete DB verificado: ${manifest.sha256}\n`);

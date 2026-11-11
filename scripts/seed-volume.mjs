/**
 * scripts/seed-volume.mjs
 * Poblado masivo de datos para la simulación San Valentín (Sprint 04 · Jhon Jumbo).
 *
 * Uso:
 *   node --env-file-if-exists=.env scripts/seed-volume.mjs
 *
 * Variables de entorno requeridas:
 *   DATABASE_URL  - cadena de conexión PostgreSQL con el rol logistica_app.
 *
 * El script usa SOLO las funciones autorizadas de logistica_app:
 *   create_zone, create_order, create_courier, set_courier_availability.
 * No modifica migraciones, tablas de auditoría ni permisos.
 *
 * Idempotencia: si se ejecuta dos veces sobre la misma base, los pedidos
 * adicionales se acumularán porque create_order no tiene clave de conflicto
 * determinista. Para un entorno de prueba limpio, truncar primero con
 * scripts/run-postgres-integration.mjs (que gestiona el contenedor efímero).
 */

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);

// Importar cliente Prisma desde el build ya generado.
// Si el adapter PrismaPg está instalado lo usamos; de lo contrario usamos el
// adaptador de conexión estándar de Prisma que sí está disponible.
let PrismaClient;
let PrismaPg;
try {
  ({ PrismaClient } = require('@prisma/client'));
  ({ PrismaPg } = require('@prisma/adapter-pg'));
} catch {
  process.stderr.write('Error: @prisma/client no encontrado. Ejecuta npm ci primero.\n');
  process.exit(1);
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  process.stderr.write('Error: DATABASE_URL es obligatorio (definir en .env o como variable).\n');
  process.exit(1);
}

// ─── Configuración de datos San Valentín ──────────────────────────────────────

/**
 * Fecha de simulación San Valentín: próximo 14 de febrero.
 * Se calcula dinámicamente para que el script siempre use una fecha futura válida.
 */
function getValentinesDate() {
  const now = new Date();
  const year = now.getMonth() < 1 || (now.getMonth() === 1 && now.getDate() <= 14)
    ? now.getFullYear()
    : now.getFullYear() + 1;
  return `${year}-02-14`;
}

const SIM_DATE = getValentinesDate();

const ZONES = [
  'Centro Histórico',
  'Norte Empresarial',
  'Sur Residencial',
  'Valle del Comercio',
  'Puerto Industrial',
];

const COURIERS = [
  { name: 'Carlos Mendoza',   capacity: 5 },
  { name: 'Lucía Torres',     capacity: 4 },
  { name: 'Andrés Vega',      capacity: 5 },
  { name: 'María Suárez',     capacity: 4 },
  { name: 'Pedro Alarcón',    capacity: 5 },
  { name: 'Sofía Ramos',      capacity: 3 },
  { name: 'Diego Herrera',    capacity: 5 },
  { name: 'Valeria Mora',     capacity: 4 },
  { name: 'Tomás Castillo',   capacity: 5 },
  { name: 'Gabriela Ortiz',   capacity: 3 },
  { name: 'Felipe Núñez',     capacity: 5 },
  { name: 'Isabella Reyes',   capacity: 4 },
  { name: 'Sebastián Luna',   capacity: 5 },
  { name: 'Camila Jiménez',   capacity: 4 },
  { name: 'Mateo Paredes',    capacity: 5 },
  { name: 'Valentina Cruz',   capacity: 3 },
  { name: 'Nicolás Flores',   capacity: 5 },
  { name: 'Ana Guerrero',     capacity: 4 },
  { name: 'Ricardo Peña',     capacity: 5 },
  { name: 'Daniela Salazar',  capacity: 4 },
];

/** Horarios de entrega (América/Guayaquil): 08:00 a 18:00 en franjas de 1 hora */
const DELIVERY_TIMES = [
  '08:00', '09:00', '10:00', '11:00', '12:00',
  '13:00', '14:00', '15:00', '16:00', '17:00', '18:00',
];

/** Direcciones de pedidos de muestra (ciclan con módulo) */
const ADDRESSES = [
  'Av. Amazonas N23-45 y Colón',
  'Calle Guayaquil 350 y Bolívar',
  'Av. 6 de Diciembre N40-100',
  'Calle Orellana 234 y 9 de Octubre',
  'Av. República del Salvador L3-89',
  'Pasaje Veloz 12 y España',
  'Calle Chimborazo 450 y Sucre',
  'Av. Naciones Unidas 1234',
  'Calle García Moreno 56',
  'Av. 10 de Agosto 789 y Versalles',
  'Calle Venezuela 100 y Chile',
  'Av. Mariscal Sucre N56-32',
  'Urb. Los Ángeles Mz 4 Casa 7',
  'Av. Diego de Almagro 2230',
  'Calle Ibarra 78 y Cuenca',
  'Av. Eloy Alfaro N44-123',
  'Calle Rumipamba 56 y Portugal',
  'Av. Shyris 3620 y Suecia',
  'Calle Foch 345 y Reina Victoria',
  'Av. Colón 1234 y Versalles',
  'Calle Jean Martín 89',
  'Av. Los Granados E9-45',
  'Calle Manuel Larrea 234',
  'Av. América 3456 y Mañosca',
  'Calle Roca 230 y Av. Amazonas',
];

/** Recipients de muestra */
const RECIPIENTS = [
  'Rosa García', 'Manuel López', 'Fernanda Silva', 'Hugo Martínez', 'Carla Pérez',
  'Oswaldo Vega', 'Pilar Ramos', 'Ernesto Torres', 'Milagros Cruz', 'Sergio Flores',
  'Patricia Morales', 'Daniel Ortega', 'Susana Herrera', 'Alberto Vargas', 'Elena Ruiz',
  'Francisco Medina', 'Beatriz Soto', 'Marco Guerrero', 'Irene Ponce', 'Rafael Aguirre',
];

const TARGET_ORDERS = 160;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pick(array, index) {
  return array[index % array.length];
}

async function runRaw(db, sql, params = []) {
  return db.$queryRawUnsafe(sql, ...params);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const adapter = new PrismaPg({ connectionString: DATABASE_URL, max: 3, connectionTimeoutMillis: 10_000 });
  const db = new PrismaClient({ adapter });

  process.stdout.write(`\n📦 Iniciando poblado masivo — San Valentín ${SIM_DATE}\n`);
  process.stdout.write('═'.repeat(60) + '\n');

  try {
    await db.$connect();

    // 1. Crear zonas
    process.stdout.write('\n1. Creando zonas geográficas…\n');
    const zoneIds = [];
    for (const name of ZONES) {
      const rows = await runRaw(
        db,
        `SELECT logistica.create_zone($1::text) AS id`,
        [name],
      );
      const id = rows[0].id;
      zoneIds.push(id);
      process.stdout.write(`   ✔ Zona "${name}" → ${id}\n`);
    }

    // 2. Crear repartidores disponibles
    process.stdout.write('\n2. Creando repartidores…\n');
    const courierIds = [];
    for (const courier of COURIERS) {
      const rows = await runRaw(
        db,
        `SELECT logistica.create_courier($1::text, $2::integer, NULL) AS id`,
        [courier.name, courier.capacity],
      );
      const id = rows[0].id;
      await runRaw(
        db,
        `SELECT logistica.set_courier_availability($1::uuid, true)`,
        [id],
      );
      courierIds.push(id);
      process.stdout.write(`   ✔ ${courier.name} (cap. ${courier.capacity}) → ${id}\n`);
    }

    // 3. Crear pedidos
    process.stdout.write(`\n3. Creando ${TARGET_ORDERS} pedidos para ${SIM_DATE}…\n`);
    const orderIds = [];
    for (let i = 0; i < TARGET_ORDERS; i++) {
      const zoneId = pick(zoneIds, i);
      const address = pick(ADDRESSES, i);
      const time = pick(DELIVERY_TIMES, i);
      const recipient = pick(RECIPIENTS, i);
      const rows = await runRaw(
        db,
        `SELECT logistica.create_order(
           $1::uuid,
           $2::text,
           $3::date,
           $4::time,
           $5::text,
           NULL,
           'Pedido San Valentín #' || $6::text
         ) AS id`,
        [zoneId, address, SIM_DATE, time, recipient, String(i + 1)],
      );
      const id = rows[0].id;
      orderIds.push(id);
    }
    process.stdout.write(`   ✔ ${orderIds.length} pedidos creados\n`);

    // 4. Resumen
    process.stdout.write('\n' + '═'.repeat(60) + '\n');
    process.stdout.write('✅ Poblado masivo completado:\n');
    process.stdout.write(`   • Zonas:        ${zoneIds.length}\n`);
    process.stdout.write(`   • Repartidores: ${courierIds.length}\n`);
    process.stdout.write(`   • Pedidos:      ${orderIds.length}\n`);
    process.stdout.write(`   • Fecha:        ${SIM_DATE}\n`);
    process.stdout.write('\nAhora puedes ejecutar k6 apuntando al servidor local:\n');
    process.stdout.write('   k6 run scripts/k6/smoke.k6.js\n');
    process.stdout.write('   k6 run scripts/k6/san-valentin-stress.k6.js\n\n');

  } catch (error) {
    process.stderr.write(`\n❌ Error en el poblado: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main();

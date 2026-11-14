/**
 * scripts/k6/san-valentin-stress.k6.js  —  Sprint 04 · Jhon Jumbo
 *
 * Prueba de estrés — escenario "Día de San Valentín"
 * Simula alta demanda concurrente: clientes registrando pedidos de flores/regalos,
 * repartidores consultando sus rutas activas y administradores generando planes.
 *
 * Requisito APE / Enunciado §7:
 *   - Al menos 50-100 VUs concurrentes.
 *   - Tasa de error < 1 %.
 *   - p(95) < 500 ms en endpoints de escritura, < 200 ms en lectura.
 *
 * Ejecutar (con la API en localhost:3000 y datos ya sembrados):
 *   k6 run scripts/k6/san-valentin-stress.k6.js
 *   k6 run --env BASE_URL=http://localhost:3000 scripts/k6/san-valentin-stress.k6.js
 *
 * Para simular con un volumen mayor:
 *   k6 run --env BASE_URL=http://localhost:3000 --vus 100 --duration 2m scripts/k6/san-valentin-stress.k6.js
 */

import http from 'k6/http';
import { sleep, check, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ─── Métricas personalizadas ──────────────────────────────────────────────────
const errorRate         = new Rate('sv_errors');
const ordersCreated     = new Counter('sv_orders_created');
const routesQueried     = new Counter('sv_routes_queried');
const zonesQueried      = new Counter('sv_zones_queried');
const readLatency       = new Trend('sv_read_latency_ms',  true);
const writeLatency      = new Trend('sv_write_latency_ms', true);

// ─── Configuración ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

/** Fecha San Valentín del año en curso o del próximo año si ya pasó */
function valentinesDate() {
  const now = new Date();
  const year =
    now.getMonth() < 1 || (now.getMonth() === 1 && now.getDate() <= 14)
      ? now.getFullYear()
      : now.getFullYear() + 1;
  return `${year}-02-14`;
}
const SIM_DATE = valentinesDate();

/** Genera un UUID v4 simplificado (suficiente para pruebas de carga) */
function uuidV4() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/** Horarios disponibles para San Valentín */
const TIMES = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];

/** Direcciones de muestra para los pedidos */
const ADDRESSES = [
  'Av. Amazonas 234 y Colón',
  'Calle Bolívar 100 y Guayaquil',
  'Av. 6 de Diciembre N45-99',
  'Pasaje Veloz 12 y España',
  'Urb. Los Álamos Mz 3 Casa 5',
  'Av. República 890 y Naciones Unidas',
  'Calle Orellana 56 y 10 de Agosto',
  'Av. Shyris 2340 y Suecia',
  'Calle Foch 123 y Reina Victoria',
  'Av. Eloy Alfaro N52-88',
];

export const options = {
  scenarios: {
    // Escenario 1: Clientes creando pedidos de San Valentín (rampa 10→50 VUs)
    clientes: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: 10  },  // calentamiento
        { duration: '60s', target: 50  },  // pico máximo
        { duration: '30s', target: 25  },  // descenso parcial
        { duration: '20s', target: 0   },  // apagado
      ],
      exec: 'clienteFlow',
    },
    // Escenario 2: Repartidores consultando rutas asignadas (rampa 5→30 VUs)
    repartidores: {
      executor: 'ramping-vus',
      startTime: '15s',  // inician con ligero retraso
      stages: [
        { duration: '30s', target: 5   },
        { duration: '60s', target: 30  },
        { duration: '30s', target: 10  },
        { duration: '15s', target: 0   },
      ],
      exec: 'repartidorFlow',
    },
    // Escenario 3: Administrador consultando zonas y pedidos (carga constante 5 VUs)
    administradores: {
      executor: 'constant-vus',
      vus: 5,
      duration: '2m',
      exec: 'adminFlow',
    },
  },
  thresholds: {
    // Tasa de error global < 1 %
    sv_errors:         ['rate<0.01'],
    // Latencia de lectura p(95) < 200 ms
    sv_read_latency_ms:  ['p(95)<200', 'p(99)<400'],
    // Latencia de escritura p(95) < 500 ms (incluye validación DB)
    sv_write_latency_ms: ['p(95)<500', 'p(99)<800'],
    // Métricas nativas de k6
    http_req_failed:    ['rate<0.01'],
    http_req_duration:  ['p(95)<500'],
  },
};

// ─── Variables compartidas (cargadas en setup) ────────────────────────────────
export function setup() {
  let token = __ENV.AUTH_TOKEN || '';
  if (!token) {
    const email = __ENV.AUTH_EMAIL || `k6-stress-${Date.now()}@ultima-milla.test`;
    const password = __ENV.AUTH_PASSWORD || 'K6StressPassword2026!';
    const authHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    let authRes = http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password, displayName: 'K6 Stress Client' }),
      { headers: authHeaders, timeout: '10s' },
    );
    if (authRes.status === 409) {
      authRes = http.post(
        `${BASE_URL}/auth/login`,
        JSON.stringify({ email, password }),
        { headers: authHeaders, timeout: '10s' },
      );
    }
    try {
      token = JSON.parse(authRes.body).token || '';
    } catch {
      token = '';
    }
  }

  // Consultar zonas disponibles; si no hay, el test continúa sin crearlas.
  const res = http.get(`${BASE_URL}/zones`, {
    headers: token
      ? { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
      : { 'Accept': 'application/json' },
    timeout: '10s',
  });
  let zoneIds = [];
  try {
    const body = JSON.parse(res.body);
    if (Array.isArray(body.items) && body.items.length > 0) {
      zoneIds = body.items.map((z) => z.id).filter(Boolean);
    }
  } catch (parseErr) {
    // body no es JSON válido; zoneIds queda vacío y los tests POST recibirán 4xx.
    void parseErr;
  }

  if (zoneIds.length === 0) {
    // Aviso al operador: ejecutar seed antes del test.
    // eslint-disable-next-line no-console
    console.warn(
      'No se encontraron zonas en la base de datos. ' +
      'Ejecuta primero: node --env-file-if-exists=.env scripts/seed-volume.mjs\n' +
      'Los tests POST /orders recibirán 4xx esperados.',
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`San Valentín Stress — ${zoneIds.length} zonas disponibles. Fecha: ${SIM_DATE}`);
  }

  return { zoneIds, token };
}

// ─── Escenario 1: Cliente registrando pedido ──────────────────────────────────
export function clienteFlow(data) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    ...(data && data.token ? { 'Authorization': `Bearer ${data.token}` } : {}),
  };

  group('cliente: registrar pedido San Valentín', () => {
    const zoneIds = data.zoneIds;
    const zoneId = zoneIds.length > 0
      ? zoneIds[Math.floor(Math.random() * zoneIds.length)]
      : uuidV4(); // UUID inválido → recibirá 4xx; no cuenta como error inesperado

    const address = ADDRESSES[Math.floor(Math.random() * ADDRESSES.length)];
    const time    = TIMES[Math.floor(Math.random() * TIMES.length)];

    const payload = JSON.stringify({
      zoneId,
      deliveryAddress: `${address} (San Valentín)`,
      deliveryDate: SIM_DATE,
      deliveryTime: time,
    });

    const res = http.post(`${BASE_URL}/orders`, payload, {
      headers,
      tags:    { name: 'POST /orders' },
      timeout: '10s',
    });

    writeLatency.add(res.timings.duration);

    const ok = check(res, {
      'POST /orders: 201 o 404 zona':
        (r) => r.status === 201 || r.status === 404 || r.status === 400,
      'POST /orders: body JSON válido':
        (r) => { try { JSON.parse(r.body); return true; } catch { return false; } },
    });

    if (res.status === 201) {
      ordersCreated.add(1);
    } else if (res.status !== 404 && res.status !== 400) {
      // 5xx son errores reales que cuentan como fallo.
      errorRate.add(1);
    }
    if (!ok && (res.status === 201 || res.status < 400)) {
      errorRate.add(1);
    }
  });

  sleep(Math.random() * 1 + 0.3);  // pausa 0.3–1.3 s entre iteraciones
}

// ─── Escenario 2: Repartidor consultando rutas y zonas ───────────────────────
export function repartidorFlow(data) {
  const headers = {
    'Accept': 'application/json',
    ...(data && data.token ? { 'Authorization': `Bearer ${data.token}` } : {}),
  };

  group('repartidor: consultar zonas y pedidos de su zona', () => {
    // Consulta de zonas
    {
      const res = http.get(`${BASE_URL}/zones`, {
        headers,
        tags:    { name: 'GET /zones' },
        timeout: '8s',
      });
      readLatency.add(res.timings.duration);
      const ok = check(res, {
        'GET /zones: status 200': (r) => r.status === 200,
      });
      if (!ok) errorRate.add(1);
      else zonesQueried.add(1);
    }

    sleep(0.2);

    // Consulta de pedidos del día San Valentín
    {
      const res = http.get(`${BASE_URL}/orders?deliveryDate=${SIM_DATE}`, {
        headers,
        tags:    { name: 'GET /orders (by date)' },
        timeout: '8s',
      });
      readLatency.add(res.timings.duration);
      const ok = check(res, {
        'GET /orders by date: status 200':
          (r) => r.status === 200,
        'GET /orders by date: items presentes':
          (r) => {
            try { return Array.isArray(JSON.parse(r.body).items); }
            catch { return false; }
          },
      });
      if (!ok) errorRate.add(1);
      else routesQueried.add(1);
    }
  });

  sleep(Math.random() * 0.8 + 0.2);
}

// ─── Escenario 3: Administrador revisando estado general ─────────────────────
export function adminFlow(data) {
  const headers = {
    'Accept': 'application/json',
    ...(data && data.token ? { 'Authorization': `Bearer ${data.token}` } : {}),
  };

  group('admin: health check y listados', () => {
    // Health
    {
      const res = http.get(`${BASE_URL}/health`, {
        headers,
        tags:    { name: 'GET /health (admin)' },
        timeout: '5s',
      });
      readLatency.add(res.timings.duration);
      const ok = check(res, {
        'health: 200': (r) => r.status === 200,
      });
      if (!ok) errorRate.add(1);
    }

    sleep(0.2);

    // Listado de zonas
    {
      const res = http.get(`${BASE_URL}/zones`, {
        headers,
        tags:    { name: 'GET /zones (admin)' },
        timeout: '5s',
      });
      readLatency.add(res.timings.duration);
      const ok = check(res, {
        'zones admin: 200': (r) => r.status === 200,
      });
      if (!ok) errorRate.add(1);
    }

    sleep(0.5);
  });
}

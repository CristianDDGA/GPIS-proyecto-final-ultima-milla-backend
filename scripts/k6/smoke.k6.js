/**
 * scripts/k6/smoke.k6.js  —  Sprint 04 · Jhon Jumbo
 *
 * Prueba de humo (Smoke Test) — 1-5 VUs durante 30 s.
 * Verifica que los endpoints base respondan correctamente antes de un
 * test de estrés. Si algo aquí falla, el escenario San Valentín no se ejecuta.
 *
 * Requisito APE / Enunciado §7: p(95) < 150 ms, tasa de error < 1 %.
 *
 * Ejecutar (con la API en localhost:3000):
 *   k6 run scripts/k6/smoke.k6.js
 *   k6 run --env BASE_URL=http://localhost:3000 scripts/k6/smoke.k6.js
 */

import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ─── Métricas personalizadas ──────────────────────────────────────────────────
const errorRate = new Rate('smoke_errors');
const latencyHealth = new Trend('latency_health_ms', true);
const latencyZones = new Trend('latency_zones_ms', true);
const latencyOrders = new Trend('latency_orders_ms', true);

// ─── Configuración ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '10s', target: 1 },  // arranque suave
    { duration: '15s', target: 5 },  // pico moderado
    { duration: '5s',  target: 0 },  // descenso
  ],
  thresholds: {
    // La tasa de error global debe ser < 1 %.
    smoke_errors: ['rate<0.01'],
    // Latencia p(95) < 150 ms para cada endpoint.
    latency_health_ms:  ['p(95)<150'],
    latency_zones_ms:   ['p(95)<150'],
    latency_orders_ms:  ['p(95)<150'],
    // Umbral genérico sobre todas las peticiones HTTP.
    http_req_duration:  ['p(95)<200'],
    http_req_failed:    ['rate<0.01'],
  },
};

// ─── Escenario ────────────────────────────────────────────────────────────────
export default function smokeTest() {
  const headers = { 'Accept': 'application/json' };

  // GET /health
  {
    const res = http.get(`${BASE_URL}/health`, { headers, tags: { name: 'health' } });
    latencyHealth.add(res.timings.duration);
    const ok = check(res, {
      'health: status 200':          (r) => r.status === 200,
      'health: body tiene status ok': (r) => {
        try { return JSON.parse(r.body).status === 'ok'; }
        catch { return false; }
      },
    });
    errorRate.add(!ok);
  }

  sleep(0.3);

  // GET /zones
  {
    const res = http.get(`${BASE_URL}/zones`, { headers, tags: { name: 'zones' } });
    latencyZones.add(res.timings.duration);
    const ok = check(res, {
      'zones: status 200':        (r) => r.status === 200,
      'zones: items es un array': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.items);
        } catch { return false; }
      },
    });
    errorRate.add(!ok);
  }

  sleep(0.3);

  // GET /orders
  {
    const res = http.get(`${BASE_URL}/orders`, { headers, tags: { name: 'orders' } });
    latencyOrders.add(res.timings.duration);
    const ok = check(res, {
      'orders: status 200':        (r) => r.status === 200,
      'orders: items es un array': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.items);
        } catch { return false; }
      },
    });
    errorRate.add(!ok);
  }

  sleep(0.5);
}

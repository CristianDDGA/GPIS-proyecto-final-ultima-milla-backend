import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { loadConfig } from '../../src/bootstrap/config.js';

describe('Integration Test Harness - Health Check', () => {
  const app = createApp({ webOrigin: 'http://localhost:5173' });

  it('GET /health returns 200 with status ok', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('CORS con la configuración local predeterminada', () => {
  const app = createApp(loadConfig({}));

  it('acepta el preflight del origen que usa Vite', async () => {
    const response = await request(app).options('/zones')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Access-Control-Request-Method', 'POST');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
  });

  it('rechaza el preflight de un origen diferente sin wildcard', async () => {
    const response = await request(app).options('/zones').set('Origin', 'https://untrusted.example');
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

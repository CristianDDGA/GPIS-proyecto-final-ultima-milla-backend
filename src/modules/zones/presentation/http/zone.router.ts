import { Router } from 'express';
import type { ZoneController } from './zone.controller.js';

export function createZoneRouter(controller: ZoneController): Router {
  const router = Router();

  router.post('/', (request, response) => {
    void controller.create(request, response);
  });

  router.get('/', (request, response) => {
    void controller.list(request, response);
  });

  // Antes de '/:id' para que 'lookup' no se lea como identificador.
  router.get('/lookup', (request, response) => {
    void controller.lookup(request, response);
  });

  router.put('/:id/coverage', (request, response) => {
    void controller.setCoverage(request, response);
  });

  router.patch('/:id', (request, response) => {
    void controller.setActive(request, response);
  });

  router.get('/:id', (request, response) => {
    void controller.getById(request, response);
  });

  return router;
}

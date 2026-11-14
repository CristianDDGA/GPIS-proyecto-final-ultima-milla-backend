import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, RequestHandler, Response } from 'express';
import type { TokenPayload, TokenService } from '../modules/auth/application/ports/token-service.port.js';
import type { AppRole } from '../modules/auth/domain/auth-user.entity.js';
import { AuthError } from '../modules/auth/domain/auth.errors.js';

const actorStorage = new AsyncLocalStorage<TokenPayload>();

export function getRequestActor(): TokenPayload | undefined {
  return actorStorage.getStore();
}

function sendAuthMiddlewareError(response: Response, status: number, code: 'UNAUTHORIZED' | 'FORBIDDEN', message: string): void {
  response.status(status).json({ code, message, error: { code, message } });
}

function extractBearer(request: Request, tokens: TokenService): TokenPayload {
  const header = request.get('authorization');
  if (!header) {
    throw new AuthError('UNAUTHORIZED');
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) {
    throw new AuthError('UNAUTHORIZED', 'Cabecera Authorization Bearer inválida.');
  }
  return tokens.verify(match[1]);
}

function isPublicRoute(method: string, path: string): boolean {
  if (method === 'OPTIONS') return true;
  if (method === 'GET' && path === '/health') return true;
  return path === '/auth' || path.startsWith('/auth/');
}

interface RoutePolicy {
  readonly roles: readonly AppRole[];
  readonly courierSelfPath?: RegExp;
}

const COURIER_AVAILABILITY_RE = /^\/couriers\/([^/]+)\/availability\/?$/;
const COURIER_ROUTE_RE = /^\/couriers\/([^/]+)\/route\/?$/;

function resolvePolicy(method: string, path: string): RoutePolicy | null {
  if (path === '/zones' || path.startsWith('/zones/')) {
    if (method === 'GET') return { roles: ['personal', 'repartidor', 'cliente'] };
    if (method === 'POST') return { roles: ['personal'] };
  }

  if (path === '/orders' || path.startsWith('/orders/')) {
    if (method === 'POST') return { roles: ['personal', 'cliente'] };
    if (method === 'GET') return { roles: ['personal', 'repartidor', 'cliente'] };
  }

  if (
    path === '/route-plans' || path.startsWith('/route-plans/') ||
    path === '/route-moves' || path.startsWith('/route-moves/') ||
    path === '/late-order-placements' || path.startsWith('/late-order-placements/')
  ) {
    return { roles: ['personal'] };
  }

  if (path === '/routes' || path.startsWith('/routes/')) {
    if (method === 'GET') return { roles: ['personal', 'repartidor'] };
    if (method === 'PUT') return { roles: ['personal'] };
  }

  if (COURIER_AVAILABILITY_RE.test(path) && method === 'PATCH') {
    return { roles: ['personal', 'repartidor'], courierSelfPath: COURIER_AVAILABILITY_RE };
  }

  if (COURIER_ROUTE_RE.test(path) && method === 'GET') {
    return { roles: ['personal', 'repartidor'], courierSelfPath: COURIER_ROUTE_RE };
  }

  if (
    path === '/couriers' || path.startsWith('/couriers/') ||
    path === '/courier-assignments' || path.startsWith('/courier-assignments/')
  ) {
    return { roles: ['personal'] };
  }

  if (
    path === '/delivery-orders' || path.startsWith('/delivery-orders/') ||
    path === '/delivery-status-changes' || path.startsWith('/delivery-status-changes/') ||
    path === '/route-completions' || path.startsWith('/route-completions/')
  ) {
    return { roles: ['personal', 'repartidor'] };
  }

  return null;
}

export function createRbacMiddleware(tokens: TokenService): RequestHandler {
  return (request, response, next) => {
    if (isPublicRoute(request.method, request.path)) {
      next();
      return;
    }

    let actor: TokenPayload;
    try {
      actor = extractBearer(request, tokens);
    } catch (error: unknown) {
      const message = error instanceof AuthError ? error.message : 'Se requiere autenticación válida.';
      sendAuthMiddlewareError(response, 401, 'UNAUTHORIZED', message);
      return;
    }

    const policy = resolvePolicy(request.method, request.path);
    if (policy !== null) {
      if (!policy.roles.includes(actor.role)) {
        sendAuthMiddlewareError(response, 403, 'FORBIDDEN', 'No tienes permisos para realizar esta acción.');
        return;
      }
      if (policy.courierSelfPath && actor.role === 'repartidor') {
        const match = policy.courierSelfPath.exec(request.path);
        const targetCourierId = match?.[1]?.toLowerCase();
        if (!actor.courierId || actor.courierId.toLowerCase() !== targetCourierId) {
          sendAuthMiddlewareError(
            response,
            403,
            'FORBIDDEN',
            'El conductor solo puede consultar o modificar su propio perfil de repartidor.',
          );
          return;
        }
      }
    }

    actorStorage.run(actor, () => next());
  };
}

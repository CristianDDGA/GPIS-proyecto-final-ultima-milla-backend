export class RouteValidationError extends Error {
  readonly code = 'VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RouteValidationError';
  }
}

export class RouteNotFoundError extends Error {
  readonly code = 'ROUTE_NOT_FOUND' as const;

  constructor(message: string = 'Ruta no encontrada.') {
    super(message);
    this.name = 'RouteNotFoundError';
  }
}

// Route operations reference orders by identity; a missing order keeps the Sprint 01 code.
export class RouteOrderNotFoundError extends Error {
  readonly code = 'ORDER_NOT_FOUND' as const;

  constructor(message: string = 'Pedido no encontrado.') {
    super(message);
    this.name = 'RouteOrderNotFoundError';
  }
}

export class RouteConflictError extends Error {
  readonly code = 'DATA_CONFLICT' as const;

  constructor(message: string = 'La planificación entra en conflicto con los datos actuales.') {
    super(message);
    this.name = 'RouteConflictError';
  }
}

export class RoutePersistenceUnavailableError extends Error {
  readonly code = 'PERSISTENCE_UNAVAILABLE' as const;

  constructor(message: string = 'Persistencia no disponible temporalmente.') {
    super(message);
    this.name = 'RoutePersistenceUnavailableError';
  }
}

// A persisted route that breaks a planning invariant is an internal fault, never client input.
export class RouteIntegrityError extends Error {
  readonly code = 'INTERNAL_SERVER_ERROR' as const;

  constructor(message: string = 'La ruta almacenada no cumple las reglas de planificación.') {
    super(message);
    this.name = 'RouteIntegrityError';
  }
}

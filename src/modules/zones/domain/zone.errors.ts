export class ZoneValidationError extends Error {
  readonly code = 'VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ZoneValidationError';
  }
}

export class ZoneNotFoundError extends Error {
  readonly code = 'ZONE_NOT_FOUND' as const;

  constructor(message: string = 'Zona no encontrada.') {
    super(message);
    this.name = 'ZoneNotFoundError';
  }
}

export class ZoneConflictError extends Error {
  readonly code = 'DATA_CONFLICT' as const;

  constructor(message: string = 'Ya existe una zona con ese nombre.') {
    super(message);
    this.name = 'ZoneConflictError';
  }
}

export class PersistenceUnavailableError extends Error {
  readonly code = 'PERSISTENCE_UNAVAILABLE' as const;

  constructor(message: string = 'Persistencia no disponible temporalmente.') {
    super(message);
    this.name = 'PersistenceUnavailableError';
  }
}

export class ZoneInUseError extends Error {
  readonly code = 'ZONE_IN_USE' as const;

  constructor(message: string = 'No se puede desactivar la zona: tiene rutas activas o pedidos sin cerrar. Termínalos, cancélalos o reasígnalos primero.') {
    super(message);
    this.name = 'ZoneInUseError';
  }
}

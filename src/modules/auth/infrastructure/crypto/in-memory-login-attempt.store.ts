import type { LoginAttemptStore } from '../../application/ports/login-attempt.port.js';

export interface LoginLockoutOptions {
  /** Fallos dentro de la ventana que activan el bloqueo. */
  readonly maxFailures: number;
  /** Duración del bloqueo. */
  readonly lockSeconds: number;
  /** Ventana en la que se cuentan los fallos (por defecto 15 minutos). */
  readonly windowSeconds?: number;
  readonly now?: () => number;
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

const MAX_TRACKED_KEYS = 10_000;

// En memoria: se reinicia con el proceso y no se comparte entre instancias. Suficiente para una sola instancia de la API.
export class InMemoryLoginAttemptStore implements LoginAttemptStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(private readonly options: LoginLockoutOptions) {
    this.now = options.now ?? Date.now;
    this.windowMs = (options.windowSeconds ?? 900) * 1000;
  }

  async lockedForSeconds(key: string): Promise<number> {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const remainingMs = entry.lockedUntil - this.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  async recordFailure(key: string): Promise<void> {
    const current = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_TRACKED_KEYS) this.purge(current);
      entry = { failures: [], lockedUntil: 0 };
      this.entries.set(key, entry);
    }
    entry.failures = entry.failures.filter((at) => current - at < this.windowMs);
    entry.failures.push(current);
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = current + this.options.lockSeconds * 1000;
      entry.failures = [];
    }
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  // Descarta entradas sin bloqueo vigente ni fallos recientes; si sigue lleno, la más antigua.
  private purge(current: number): void {
    for (const [key, entry] of this.entries) {
      const recent = entry.failures.some((at) => current - at < this.windowMs);
      if (entry.lockedUntil <= current && !recent) this.entries.delete(key);
    }
    while (this.entries.size >= MAX_TRACKED_KEYS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

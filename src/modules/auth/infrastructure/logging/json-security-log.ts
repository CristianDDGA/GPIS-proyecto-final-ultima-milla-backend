import type { SecurityEvent, SecurityLog } from '../../application/ports/security-log.port.js';

/** Una línea JSON por evento (fácil de filtrar con grep o enviar a un agregador de logs). */
export function createJsonSecurityLog(
  write: (line: string) => void = (line) => { process.stdout.write(line); },
  now: () => Date = () => new Date(),
): SecurityLog {
  return (event: SecurityEvent) => {
    try {
      write(`${JSON.stringify({ ts: now().toISOString(), channel: 'security', ...event })}\n`);
    } catch {
      // El registro nunca debe romper una petición.
    }
  };
}

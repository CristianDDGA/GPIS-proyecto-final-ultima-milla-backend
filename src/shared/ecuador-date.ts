/** Fechas de calendario en la hora de Ecuador (UTC-5, sin horario de verano). Formato YYYY-MM-DD. */

/** Fecha de hoy en Ecuador. */
export function todayInEcuador(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Suma (o resta, con valores negativos) días a una fecha YYYY-MM-DD. */
export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

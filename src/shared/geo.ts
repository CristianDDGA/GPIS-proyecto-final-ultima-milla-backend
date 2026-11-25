/** Mismo rectángulo que valid_coordinates (013): Ecuador continental y Galápagos. */
export function isWithinEcuador(latitude: number, longitude: number): boolean {
  return latitude >= -5.1 && latitude <= 1.5 && longitude >= -92.5 && longitude <= -75.0;
}

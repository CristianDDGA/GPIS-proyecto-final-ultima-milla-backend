import { todayInEcuador } from '../../../../shared/ecuador-date.js';
import { RoutePlanning, type RoutePlanPreview } from '../../domain/route.entity.js';
import type { RouteRepository } from '../ports/route.repository.port.js';

export interface PreviewRoutesInput {
  readonly serviceDate: unknown;
  readonly capacityLimit: unknown;
}

/** Calcula, sin crear nada, cuántas rutas saldrían por zona con la fecha y la capacidad dadas. */
export class PreviewRoutesUseCase {
  constructor(
    private readonly repository: RouteRepository,
    private readonly today: () => string = () => todayInEcuador(),
  ) {}

  async execute(input: PreviewRoutesInput): Promise<RoutePlanPreview> {
    const command = RoutePlanning.preparePreview(input, this.today());
    const raw = await this.repository.previewPlan(command);
    return RoutePlanning.acceptPreview(command, raw);
  }
}

/** The longest model ID and the most models one LLM provider or ASR service offers, as the server enforces. */
export const MODEL_ID_LIMIT = 256;
export const ENABLED_MODEL_LIMIT = 32;

/** Adds a model ID once, keeping the existing order. */
export function addModel(models: string[], id: string): string[] {
  const model = id.trim();
  if (!model || models.includes(model) || models.length >= ENABLED_MODEL_LIMIT) return models;
  return [...models, model];
}

/** Removes a model; a removed default falls back to the first remaining model, as on the server. */
export function removeModel(models: string[], defaultModel: string, id: string) {
  const remaining = models.filter((model) => model !== id);
  return { models: remaining, defaultModel: remaining.includes(defaultModel) ? defaultModel : (remaining[0] ?? "") };
}

type ServiceWithModels = { id: string; defaultModel?: string; models?: string[] };

export type ServiceModelChoice<T extends ServiceWithModels> = { key: string; service: T; model: string };

export function serviceModelKey(serviceId: string, model: string) {
  return `${serviceId}\n${model}`;
}

/** One choice per enabled model of each service, with each service's default model first. */
export function serviceModelChoices<T extends ServiceWithModels>(services: T[]): ServiceModelChoice<T>[] {
  return services.flatMap((service) => {
    const models = service.models?.length ? service.models : service.defaultModel ? [service.defaultModel] : [];
    const ordered = service.defaultModel
      ? [service.defaultModel, ...models.filter((model) => model !== service.defaultModel)]
      : models;
    return ordered.map((model) => ({ key: serviceModelKey(service.id, model), service, model }));
  });
}

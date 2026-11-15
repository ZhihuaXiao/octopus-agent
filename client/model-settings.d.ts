export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
}
export interface CustomModel {
  id: string;
  contextWindow?: number;
  enabled?: boolean;
}
export interface CustomProvider {
  id: string;
  baseUrl: string;
  api: string;
  apiKeySet: boolean;
  apiKeyFromCommand: boolean;
  models: CustomModel[];
}
export interface ModelPage {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinking?: string;
  thinkingLevels: string[];
  apis: string[];
  models: ModelChoice[];
  keyed: string[];
  modelEnabled?: Record<string, boolean>;
  providers: CustomProvider[];
}
export interface ProviderEdit {
  id: string;
  baseUrl: string;
  api: string;
  models: CustomModel[];
  apiKey?: string;
}
export function modelsForProvider(page: ModelPage, provider: string): ModelChoice[];
export function providerIds(page: ModelPage): string[];
export function providerKeyed(page: ModelPage | undefined, provider: string): boolean;
export function localEndpoint(baseUrl: string): boolean;
export function modelEnabled(
  model: Pick<ModelChoice, "provider" | "id">,
  page: ModelPage | undefined,
): boolean;
export function configuredChoice(
  model: Pick<ModelChoice, "provider" | "id">,
  page: ModelPage | undefined,
): boolean;
export function providerEdits(providers: CustomProvider[]): ProviderEdit[];
export function contextTokens(value: string, fallback: number): number;
export function validateProvider(provider: ProviderEdit, apis: string[]): void;

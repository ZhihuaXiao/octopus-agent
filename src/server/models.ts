/**
 * Legacy re-export: see src/model/catalog.ts for the deep ModelCatalog module.
 */

export * from "../model/catalog.js";

// Functional helpers for backward compatibility
import { createModelCatalog, type DefaultEdit, type ProviderEdit } from "../model/catalog.js";

export const readModelPage = (agentDirectory: string) =>
  createModelCatalog({ agentDirectory }).page();

export const saveDefaultModel = (agentDirectory: string, edit: DefaultEdit) =>
  createModelCatalog({ agentDirectory }).setDefault(edit);

export const saveModelEnabled = (
  agentDirectory: string,
  provider: string,
  id: string,
  enabled: boolean,
) => createModelCatalog({ agentDirectory }).setEnabled(provider, id, enabled);

export const saveProviders = (agentDirectory: string, edits: readonly ProviderEdit[]) =>
  createModelCatalog({ agentDirectory }).saveProviders(edits);

export const isConfiguredModel = (agentDirectory: string, provider: string, id: string) =>
  createModelCatalog({ agentDirectory }).isConfigured(provider, id);

export const testConfiguredModel = (agentDirectory: string, provider: string, id: string) =>
  createModelCatalog({ agentDirectory }).test(provider, id);

export const saveProviderKey = (agentDirectory: string, provider: string, apiKey: string) =>
  createModelCatalog({ agentDirectory }).saveKey(provider, apiKey);

export const removeProviderKey = (agentDirectory: string, provider: string) =>
  createModelCatalog({ agentDirectory }).removeKey(provider);

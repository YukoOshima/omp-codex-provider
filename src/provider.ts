import type { ThinkingConfig } from "@oh-my-pi/pi-ai";
import type { ProviderConfigInput } from "@oh-my-pi/pi-coding-agent";
import type { ProviderFileConfig } from "./config.ts";

export const PROVIDER_ID = "byteplus-gateway";
export const CODEX_API = "openai-codex-responses";
export const CODEX_PROVIDER_ID = "openai-codex";

export function createProviderRegistration(config: ProviderFileConfig): ProviderConfigInput {
  const models: NonNullable<ProviderConfigInput["models"]> = config.models.map(model => {
    const { thinking, ...baseModel } = model;
    return {
      ...baseModel,
      ...(thinking === undefined ? {} : { thinking: thinking as ThinkingConfig }),
      ...(model.api === CODEX_API
        ? {
            remoteCompaction: {
              enabled: true,
              api: CODEX_API,
              v2StreamingEnabled: true,
              model: model.id,
            },
          }
        : {}),
    };
  });

  return {
    // OMP requires a provider-level base URL when models are registered. Every
    // actual request uses the model-level URL, which is mandatory in our schema.
    baseUrl: models[0]!.baseUrl,
    apiKey: config.apiKey,
    models,
  };
}

/**
 * Point OMP's built-in Codex search provider at the configured gateway model.
 * Omitting `models` deliberately preserves the built-in openai-codex catalog.
 */
export function createCodexSearchProviderRegistration(config: ProviderFileConfig): ProviderConfigInput | undefined {
  if (config.webSearchModel === undefined) return undefined;
  const model = config.models.find(candidate => candidate.id === config.webSearchModel && candidate.api === CODEX_API);
  if (!model) {
    throw new Error(`webSearchModel ${config.webSearchModel} is not a configured ${CODEX_API} model`);
  }
  return {
    baseUrl: model.baseUrl,
    apiKey: config.apiKey,
  };
}

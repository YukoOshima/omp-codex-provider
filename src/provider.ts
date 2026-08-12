import type { ThinkingConfig } from "@oh-my-pi/pi-ai";
import type { ProviderConfigInput } from "@oh-my-pi/pi-coding-agent";
import type { ProviderFileConfig } from "./config.ts";

export const PROVIDER_ID = "byteplus-gateway";
export const CODEX_API = "openai-codex-responses";

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

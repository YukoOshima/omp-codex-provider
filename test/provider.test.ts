import { describe, expect, test } from "bun:test";
import type { ProviderFileConfig } from "../src/config.ts";
import { CODEX_API, createProviderRegistration, PROVIDER_ID } from "../src/provider.ts";

const CONFIG: ProviderFileConfig = {
  version: 1,
  apiKey: "BYTEPLUS_GATEWAY_API_KEY",
  models: [
    {
      id: "gpt-codex-test",
      name: "Codex Test",
      api: CODEX_API,
      baseUrl: "https://gateway.example.com/v1/responses?omp_codex_suffix=",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinking: { mode: "effort", efforts: ["high", "max"], defaultLevel: "max" },
    },
    {
      id: "claude-test",
      name: "Claude Test",
      api: "anthropic-messages",
      baseUrl: "https://gateway.example.com",
      reasoning: true,
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 32768,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      thinking: { mode: "anthropic-adaptive", efforts: ["max"], defaultLevel: "max" },
    },
  ],
};

describe("createProviderRegistration", () => {
  test("targets the existing BytePlus provider and preserves per-model URLs", () => {
    const registration = createProviderRegistration(CONFIG);

    expect(PROVIDER_ID).toBe("byteplus-gateway");
    expect(registration.baseUrl).toBe(CONFIG.models[0]!.baseUrl);
    expect(registration.apiKey).toBe("BYTEPLUS_GATEWAY_API_KEY");
    expect(registration.api).toBeUndefined();
    expect(registration.streamSimple).toBeUndefined();
    expect(registration.models?.map(model => [model.id, model.baseUrl])).toEqual([
      ["gpt-codex-test", "https://gateway.example.com/v1/responses?omp_codex_suffix="],
      ["claude-test", "https://gateway.example.com"],
    ]);
  });

  test("keeps Codex models native and enables endpoint-free V2 compaction", () => {
    const registration = createProviderRegistration(CONFIG);
    const codex = registration.models?.find(model => model.id === "gpt-codex-test");
    const anthropic = registration.models?.find(model => model.id === "claude-test");

    expect(codex?.api).toBe(CODEX_API);
    expect(codex?.remoteCompaction).toEqual({
      enabled: true,
      api: CODEX_API,
      v2StreamingEnabled: true,
      model: "gpt-codex-test",
    });
    expect(anthropic?.api).toBe("anthropic-messages");
    expect(anthropic?.remoteCompaction).toBeUndefined();
  });
});

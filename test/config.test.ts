import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CONFIG_FILE_NAME, loadProviderConfig, parseProviderConfig, providerConfigPath } from "../src/config.ts";

const temporaryDirectories: string[] = [];

function codexModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gpt-codex-test",
    name: "Codex Test",
    api: "openai-codex-responses",
    baseUrl: "https://gateway.example.com/v1/responses?omp_codex_suffix=",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinking: {
      mode: "effort",
      efforts: ["medium", "high", "xhigh", "max"],
      defaultLevel: "high",
      supportsDisplay: true,
    },
    ...overrides,
  };
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    apiKey: "literal-test-key",
    models: [codexModel()],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("parseProviderConfig", () => {
  test("accepts a strict mixed-wire provider and resolves apiKeyEnv", () => {
    const config = parseProviderConfig(
      validConfig({
        apiKey: undefined,
        apiKeyEnv: "BYTEPLUS_GATEWAY_API_KEY",
        models: [
          codexModel(),
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
            thinking: {
              mode: "anthropic-adaptive",
              efforts: ["high", "max"],
              defaultLevel: "max",
            },
          },
        ],
      }),
      { BYTEPLUS_GATEWAY_API_KEY: "secret" },
    );

    expect(config.apiKey).toBe("BYTEPLUS_GATEWAY_API_KEY");
    expect(config.models.map(model => [model.id, model.api])).toEqual([
      ["gpt-codex-test", "openai-codex-responses"],
      ["claude-test", "anthropic-messages"],
    ]);
  });

  test.each([
    ["both secret fields", validConfig({ apiKeyEnv: "BYTEPLUS_GATEWAY_API_KEY" }), "exactly one of apiKey or apiKeyEnv"],
    ["missing environment secret", validConfig({ apiKey: undefined, apiKeyEnv: "MISSING_KEY" }), "MISSING_KEY is not set"],
    ["unknown root field", validConfig({ extra: true }), "unknown field(s): extra"],
    ["duplicate model IDs", validConfig({ models: [codexModel(), codexModel()] }), "duplicate id(s): gpt-codex-test"],
    [
      "missing Codex model",
      validConfig({
        models: [
          codexModel({
            id: "claude-only",
            api: "anthropic-messages",
            baseUrl: "https://gateway.example.com",
            thinking: { mode: "anthropic-adaptive", efforts: ["max"], defaultLevel: "max" },
          }),
        ],
      }),
      "at least one openai-codex-responses model",
    ],
    ["non-HTTPS URL", validConfig({ models: [codexModel({ baseUrl: "http://gateway.example.com/v1/responses?omp_codex_suffix=" })] }), "must use https"],
    [
      "credentials embedded in URL",
      validConfig({ models: [codexModel({ baseUrl: "https://user:pass@gateway.example.com/v1/responses?omp_codex_suffix=" })] }),
      "must not contain credentials",
    ],
    [
      "Codex suffix sentinel missing",
      validConfig({ models: [codexModel({ baseUrl: "https://gateway.example.com/v1/responses" })] }),
      "must end with ?omp_codex_suffix=",
    ],
    [
      "incompatible thinking mode",
      validConfig({ models: [codexModel({ thinking: { mode: "anthropic-adaptive", efforts: ["max"] } })] }),
      "must be effort for openai-codex-responses",
    ],
    [
      "default effort absent from supported efforts",
      validConfig({ models: [codexModel({ thinking: { mode: "effort", efforts: ["high"], defaultLevel: "max" } })] }),
      "must also appear in efforts",
    ],
  ])("rejects %s", (_name, input, message) => {
    expect(() => parseProviderConfig(input, { BYTEPLUS_GATEWAY_API_KEY: "secret" })).toThrow(String(message));
  });

  test("never includes a literal API key in validation errors", () => {
    const secret = "sk-super-secret-do-not-log";
    try {
      parseProviderConfig(validConfig({ apiKey: secret, extra: true }), {});
      throw new Error("expected parseProviderConfig to throw");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("loadProviderConfig", () => {
  test("requires mode 0600 when the file contains a literal key", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "omp-codex-provider-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, CONFIG_FILE_NAME);
    await writeFile(configPath, JSON.stringify(validConfig()), { mode: 0o644 });
    await chmod(configPath, 0o644);

    await expect(loadProviderConfig(configPath, {})).rejects.toThrow("must have mode 0600");
    await chmod(configPath, 0o600);
    await expect(loadProviderConfig(configPath, {})).resolves.toMatchObject({ apiKey: "literal-test-key" });
  });

  test("derives the fixed config path from the active agent directory", () => {
    expect(providerConfigPath("/tmp/profile-agent")).toBe(`/tmp/profile-agent/${CONFIG_FILE_NAME}`);
  });
});

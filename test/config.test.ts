import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CONFIG_FILE_NAME,
  loadProviderConfig,
  parseProviderConfig,
  providerConfigPath,
  type ProviderModel,
} from "../src/config.ts";

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

const KIMI_K3_MODEL: ProviderModel = {
  id: "kimi-k3",
  name: "Kimi K3",
  api: "openai-completions",
  baseUrl: "https://gateway.example.com/v1",
  reasoning: true,
  input: ["text", "image"],
  supportsTools: true,
  contextWindow: 1048576,
  maxTokens: 1048576,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  thinking: {
    mode: "effort",
    efforts: ["low", "high", "max"],
    defaultLevel: "max",
    requiresEffort: true,
  },
};

function kimiK3Model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...KIMI_K3_MODEL, ...overrides };
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
          kimiK3Model(),
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
      ["kimi-k3", "openai-completions"],
      ["claude-test", "anthropic-messages"],
    ]);
  });

  test("accepts K3-style OpenAI Chat Completions metadata", () => {
    const config = parseProviderConfig(validConfig({ models: [codexModel(), kimiK3Model()] }), {});

    expect(config.models[1]).toEqual(KIMI_K3_MODEL);
  });

  test("resolves a Chat Completions apiKeyEnv override without replacing the root credential", () => {
    const modelSecret = "model-override-test-secret";
    const config = parseProviderConfig(
      validConfig({
        apiKey: undefined,
        apiKeyEnv: "ROOT_API_KEY",
        models: [codexModel(), kimiK3Model({ apiKeyEnv: "CHAT_COMPLETIONS_API_KEY" })],
      }),
      { ROOT_API_KEY: "root-provider-test-secret", CHAT_COMPLETIONS_API_KEY: modelSecret },
    );

    expect(config.apiKey).toBe("ROOT_API_KEY");
    expect(config.models[1]?.apiKey).toBe(modelSecret);
    expect(Object.hasOwn(config.models[1]!, "apiKeyEnv")).toBeFalse();
  });

  test("accepts a configured Codex web search model", () => {
    const config = parseProviderConfig(validConfig({ webSearchModel: "gpt-codex-test" }), {});

    expect(config.webSearchModel).toBe("gpt-codex-test");
  });

  test.each([
    ["both secret fields", validConfig({ apiKeyEnv: "BYTEPLUS_GATEWAY_API_KEY" }), "exactly one of apiKey or apiKeyEnv"],
    ["missing environment secret", validConfig({ apiKey: undefined, apiKeyEnv: "MISSING_KEY" }), "MISSING_KEY is not set"],
    [
      "both model secret fields",
      validConfig({
        models: [
          codexModel(),
          kimiK3Model({ apiKey: "model-test-key", apiKeyEnv: "CHAT_COMPLETIONS_API_KEY" }),
        ],
      }),
      "must contain exactly one of apiKey or apiKeyEnv when overriding model credentials",
    ],
    [
      "missing model environment secret",
      validConfig({ models: [codexModel(), kimiK3Model({ apiKeyEnv: "MISSING_MODEL_KEY" })] }),
      "MISSING_MODEL_KEY is not set",
    ],
    [
      "model credential override on a Codex API",
      validConfig({ models: [codexModel({ apiKey: "model-test-key" })] }),
      "apiKey/apiKeyEnv overrides are only supported for openai-completions",
    ],
    [
      "model credential without a root credential",
      validConfig({
        apiKey: undefined,
        models: [codexModel(), kimiK3Model({ apiKey: "model-test-key" })],
      }),
      "root must contain exactly one of apiKey or apiKeyEnv",
    ],
    ["unknown root field", validConfig({ extra: true }), "unknown field(s): extra"],
    ["duplicate model IDs", validConfig({ models: [codexModel(), codexModel()] }), "duplicate id(s): gpt-codex-test"],
    [
      "web search model missing from the configured catalog",
      validConfig({ webSearchModel: "missing-codex-model" }),
      "must name a configured openai-codex-responses model",
    ],
    [
      "web search model using a non-Codex API",
      validConfig({
        webSearchModel: "claude-search",
        models: [
          codexModel(),
          codexModel({
            id: "claude-search",
            api: "anthropic-messages",
            baseUrl: "https://gateway.example.com",
            thinking: { mode: "anthropic-adaptive", efforts: ["max"], defaultLevel: "max" },
          }),
        ],
      }),
      "must name a configured openai-codex-responses model",
    ],
    [
      "web search model using Chat Completions",
      validConfig({ webSearchModel: "kimi-k3", models: [codexModel(), kimiK3Model()] }),
      "must name a configured openai-codex-responses model",
    ],
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
    [
      "Chat Completions route included in base URL",
      validConfig({ models: [codexModel(), kimiK3Model({ baseUrl: "https://gateway.example.com/v1/chat/completions" })] }),
      "must be a base URL without the /chat/completions route for openai-completions",
    ],
    [
      "Chat Completions query string",
      validConfig({ models: [codexModel(), kimiK3Model({ baseUrl: "https://gateway.example.com/v1?route=chat" })] }),
      "must not contain a query",
    ],
    [
      "Chat Completions empty query delimiter",
      validConfig({ models: [codexModel(), kimiK3Model({ baseUrl: "https://gateway.example.com/v1?" })] }),
      "must not contain a query",
    ],
    [
      "incompatible Chat Completions thinking mode",
      validConfig({ models: [codexModel(), kimiK3Model({ thinking: { mode: "budget", efforts: ["max"] } })] }),
      "must be effort for openai-completions",
    ],
    [
      "non-boolean tool capability",
      validConfig({ models: [codexModel(), kimiK3Model({ supportsTools: "yes" })] }),
      "supportsTools must be a boolean",
    ],
    [
      "non-boolean mandatory-effort capability",
      validConfig({
        models: [
          codexModel(),
          kimiK3Model({
            thinking: { mode: "effort", efforts: ["max"], defaultLevel: "max", requiresEffort: "yes" },
          }),
        ],
      }),
      "requiresEffort must be a boolean",
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

  test("never includes a literal model API key in validation errors", () => {
    const secret = "model-super-secret-do-not-log";
    try {
      parseProviderConfig(
        validConfig({
          models: [codexModel(), kimiK3Model({ apiKey: secret, apiKeyEnv: "CHAT_COMPLETIONS_API_KEY" })],
        }),
        {},
      );
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

  test("requires mode 0600 when a model contains a literal key", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "omp-codex-provider-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, CONFIG_FILE_NAME);
    const modelSecret = "literal-model-test-key";
    const fileConfig = validConfig({
      apiKey: undefined,
      apiKeyEnv: "ROOT_API_KEY",
      models: [codexModel(), kimiK3Model({ apiKey: modelSecret })],
    });
    await writeFile(configPath, JSON.stringify(fileConfig), { mode: 0o644 });
    await chmod(configPath, 0o644);

    await expect(loadProviderConfig(configPath, { ROOT_API_KEY: "root-provider-test-secret" })).rejects.toThrow(
      "must have mode 0600",
    );
    await chmod(configPath, 0o600);
    const config = await loadProviderConfig(configPath, { ROOT_API_KEY: "root-provider-test-secret" });
    expect(config.models[1]?.apiKey).toBe(modelSecret);
  });

  test("derives the fixed config path from the active agent directory", () => {
    expect(providerConfigPath("/tmp/profile-agent")).toBe(`/tmp/profile-agent/${CONFIG_FILE_NAME}`);
  });
});

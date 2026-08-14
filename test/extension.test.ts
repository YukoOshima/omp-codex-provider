import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  SessionBeforeCompactEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import byteplusCodexProvider, {
  createGatewayCompactionHandler,
  registerConfiguredProvider,
  type LiveCompactionSession,
} from "../extensions/byteplus-codex-provider.ts";
import type { GatewayCompactionOptions } from "../src/compaction.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function writeConfig(webSearchModel?: string): Promise<string> {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "omp-codex-provider-extension-"));
  temporaryDirectories.push(agentDir);
  const configPath = path.join(agentDir, "omp-codex-provider.local.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      apiKey: "literal-test-key",
      ...(webSearchModel === undefined ? {} : { webSearchModel }),
      models: [
        {
          id: "gpt-codex-test",
          name: "Codex Test",
          api: "openai-codex-responses",
          baseUrl: "https://gateway.example.com/v1/responses?omp_codex_suffix=",
          reasoning: true,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
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
        },
      ],
    }),
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  return agentDir;
}

describe("registerConfiguredProvider", () => {
  test("loads from the active agent directory and registers byteplus-gateway", async () => {
    const agentDir = await writeConfig();
    const calls: Array<[string, ProviderConfig]> = [];
    const pi: Pick<ExtensionAPI, "registerProvider"> = {
      registerProvider(name, config) {
        calls.push([name, config]);
      },
    };

    const env: NodeJS.ProcessEnv = {};
    const release = await registerConfiguredProvider(pi, { agentDir, env, ompVersion: "17.2.15" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("byteplus-gateway");
    expect(calls[0]?.[1].models?.[0]?.api).toBe("openai-codex-responses");
    expect(calls[0]?.[1].models?.[1]).toMatchObject({
      id: "kimi-k3",
      api: "openai-completions",
      supportsTools: true,
      thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "max", requiresEffort: true },
    });
    expect(env.PI_CODEX_WEB_SEARCH_MODEL).toBeUndefined();
    release();
  });

  test("registers the provider-only search bridge and restores the previous model selection", async () => {
    const agentDir = await writeConfig("gpt-codex-test");
    const env: NodeJS.ProcessEnv = { PI_CODEX_WEB_SEARCH_MODEL: "previous-model" };
    const calls: Array<[string, ProviderConfig]> = [];
    const pi: Pick<ExtensionAPI, "registerProvider"> = {
      registerProvider(name, config) {
        calls.push([name, config]);
      },
    };

    const release = await registerConfiguredProvider(pi, { agentDir, env, ompVersion: "17.2.15" });

    expect(calls.map(([name]) => name)).toEqual(["byteplus-gateway", "openai-codex"]);
    expect(calls[1]?.[1]).toEqual({
      baseUrl: "https://gateway.example.com/v1/responses?omp_codex_suffix=",
      apiKey: "literal-test-key",
    });
    expect(env.PI_CODEX_WEB_SEARCH_MODEL).toBe("gpt-codex-test");
    release();
    expect(env.PI_CODEX_WEB_SEARCH_MODEL).toBe("previous-model");
  });

  test("keeps a shared model selection until the final session releases it", async () => {
    const agentDir = await writeConfig("gpt-codex-test");
    const env: NodeJS.ProcessEnv = {};
    const pi = { registerProvider() {} } as Pick<ExtensionAPI, "registerProvider">;

    const releaseFirst = await registerConfiguredProvider(pi, { agentDir, env, ompVersion: "17.2.15" });
    const releaseSecond = await registerConfiguredProvider(pi, { agentDir, env, ompVersion: "17.2.15" });
    releaseFirst();
    expect(env.PI_CODEX_WEB_SEARCH_MODEL).toBe("gpt-codex-test");
    releaseSecond();
    expect(env.PI_CODEX_WEB_SEARCH_MODEL).toBeUndefined();
  });

  test("fails before registration on an unsupported OMP version", async () => {
    const agentDir = await writeConfig();
    let registered = false;
    const pi: Pick<ExtensionAPI, "registerProvider"> = {
      registerProvider() {
        registered = true;
      },
    };

    await expect(registerConfiguredProvider(pi, { agentDir, env: {}, ompVersion: "17.2.14" })).rejects.toThrow(
      "requires OMP >=17.2.15 <18",
    );
    expect(registered).toBeFalse();
  });
});

describe("createGatewayCompactionHandler", () => {
  const model = {
    provider: "byteplus-gateway",
    id: "gpt-codex-test",
    api: "openai-codex-responses",
  } as Model;
  const preparation = {
    settings: { enabled: true, keepRecentTokens: 1, remoteEnabled: true, remoteStreamingV2Enabled: true },
  } as CompactionPreparation;
  const event = {
    type: "session_before_compact",
    preparation,
    branchEntries: [],
    signal: new AbortController().signal,
  } as SessionBeforeCompactEvent;
  const sessionManager = { getSessionId: () => "transcript-session-test" };
  const context = {
    model,
    sessionManager,
    modelRegistry: { getApiKey: async () => "test-key" },
  } as unknown as ExtensionContext;

  test("returns cancel on failure and forwards the live session transport contract", async () => {
    const providerSessionState = new Map<string, ProviderSessionState>();
    const session: LiveCompactionSession = {
      providerSessionState,
      preferWebsockets: true,
      sessionId: "provider-session-test",
      promptCacheKey: "prompt-cache-test",
      isStreaming: false,
    };
    let received: GatewayCompactionOptions | undefined;
    const handler = createGatewayCompactionHandler({
      compact: async (_preparation, _model, options) => {
        received = options;
        throw new Error("gateway unavailable");
      },
      resolveSession: () => session,
      getAutoCompaction: () => undefined,
      abortPendingState: () => {},
      protectSessionState: () => {},
    });

    await expect(handler(event, context)).resolves.toEqual({ cancel: true });
    expect(received?.providerSessionState).toBe(providerSessionState);
    expect(received?.preferWebsockets).toBeTrue();
    expect(received?.sessionId).toBe("provider-session-test");
    expect(received?.promptCacheKey).toBe("prompt-cache-test");
    expect(received?.codexCompaction).toMatchObject({
      trigger: "manual",
      reason: "user_requested",
      phase: "standalone_turn",
      strategy: "memento",
    });
    expect(received?.codexCompaction.operationId).toBeString();
  });

  test("classifies an in-flight automatic compaction as mid-turn", async () => {
    let received: GatewayCompactionOptions | undefined;
    const handler = createGatewayCompactionHandler({
      compact: async (_preparation, _model, options) => {
        received = options;
        throw new Error("stop after capture");
      },
      resolveSession: () => ({
        providerSessionState: new Map(),
        preferWebsockets: true,
        sessionId: "provider-session-test",
        promptCacheKey: "provider-session-test",
        isStreaming: true,
      }),
      getAutoCompaction: () => ({
        type: "auto_compaction_start",
        reason: "threshold",
        action: "context-full",
      }),
      protectSessionState: () => {},
      abortPendingState: () => {},
    });

    await expect(handler(event, context)).resolves.toEqual({ cancel: true });
    expect(received?.codexCompaction).toMatchObject({
      trigger: "auto",
      reason: "context_limit",
      phase: "mid_turn",
      strategy: "memento",
    });
  });

  test("clears an orphaned state handoff before retrying compaction", async () => {
    let abortCalls = 0;
    const handler = createGatewayCompactionHandler({
      compact: async () => {
        throw new Error("stop after resolution");
      },
      resolveSession: () => ({
        providerSessionState: new Map(),
        preferWebsockets: true,
        sessionId: "provider-session-test",
        promptCacheKey: "provider-session-test",
        isStreaming: false,
      }),
      getAutoCompaction: () => undefined,
      abortPendingState: () => {
        abortCalls++;
      },
      protectSessionState: () => {},
    });

    await expect(handler(event, context)).resolves.toEqual({ cancel: true });
    expect(abortCalls).toBe(1);
  });
});

describe("byteplusCodexProvider lifecycle", () => {
  test("restores the live Codex state after OMP accepts an extension compaction", async () => {
    const agentDir = await writeConfig("gpt-codex-test");
    const env: NodeJS.ProcessEnv = { PI_CODEX_WEB_SEARCH_MODEL: "previous-model" };
    const closed: string[] = [];
    const originalState = {
      marker: "live-state",
      close: () => closed.push("original"),
    } as ProviderSessionState & { marker: string };
    const providerSessionState = new Map<string, ProviderSessionState>([
      ["openai-codex-responses", originalState],
    ]);
    const sessionManager = { getSessionId: () => "transcript-session" };
    const liveSession = {
      sessionManager,
      providerSessionState,
      preferWebsockets: true,
      sessionId: "provider-session",
      agent: {
        promptCacheKey: "prompt-cache",
        sessionId: "provider-session",
        state: { isStreaming: true },
      },
    };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let received: GatewayCompactionOptions | undefined;
    const pi = {
      pi: {
        AgentRegistry: {
          global: () => ({ list: () => [{ session: liveSession }] }),
        },
      },
      registerProvider() {},
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
      setLabel() {},
    } as unknown as ExtensionAPI;

    await byteplusCodexProvider(pi, {
      agentDir,
      env,
      ompVersion: "17.2.15",
      compactionDependencies: {
        compact: async (_preparation, _model, options) => {
          received = options;
          return {
            item: { type: "compaction_summary", encrypted_content: "opaque" },
            replacementHistory: [{ type: "compaction_summary", encrypted_content: "opaque" }],
            usedTokens: 100,
            retainedImageCount: 0,
          };
        },
      },
    });

    const context = {
      model: { provider: "byteplus-gateway", id: "gpt-codex-test", api: "openai-codex-responses" },
      sessionManager,
      modelRegistry: { getApiKey: async () => "test-key" },
    } as unknown as ExtensionContext;
    const compactEvent = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "kept",
        tokensBefore: 1000,
        previousPreserveData: undefined,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, remoteEnabled: true, remoteStreamingV2Enabled: true },
      },
      branchEntries: [],
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    await handlers.get("auto_compaction_start")?.(
      { type: "auto_compaction_start", reason: "threshold", action: "context-full" },
      context,
    );
    const result = await handlers.get("session_before_compact")?.(compactEvent, context);

    expect(result).toMatchObject({ compaction: { preserveData: { openaiRemoteCompaction: { version: "v2" } } } });
    expect(received?.providerSessionState).toBe(providerSessionState);
    expect(received?.preferWebsockets).toBeTrue();
    expect(received?.sessionId).toBe("provider-session");
    expect(received?.promptCacheKey).toBe("prompt-cache");
    expect(received?.codexCompaction.phase).toBe("mid_turn");

    const guard = providerSessionState.get("openai-codex-responses")! as ProviderSessionState & { marker: string };
    expect(guard).not.toBe(originalState);
    expect(guard.marker).toBe("live-state");
    guard.close();
    providerSessionState.delete("openai-codex-responses");
    expect(closed).toEqual([]);

    await handlers.get("session_compact")?.(
      { type: "session_compact", compactionEntry: {}, fromExtension: true },
      context,
    );
    expect(providerSessionState.get("openai-codex-responses")).toBe(originalState);
    expect(closed).toEqual([]);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
    expect(env.PI_CODEX_WEB_SEARCH_MODEL).toBe("previous-model");
    expect(providerSessionState.get("openai-codex-responses")).toBe(originalState);
    expect(closed).toEqual([]);
  });

  test("closes a protected state when automatic compaction aborts before commit", async () => {
    const agentDir = await writeConfig();
    const closed: string[] = [];
    const originalState: ProviderSessionState = { close: () => closed.push("original") };
    const providerSessionState = new Map<string, ProviderSessionState>([
      ["openai-codex-responses", originalState],
    ]);
    const sessionManager = { getSessionId: () => "transcript-session" };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      pi: {
        AgentRegistry: {
          global: () => ({
            list: () => [
              {
                session: {
                  sessionManager,
                  providerSessionState,
                  preferWebsockets: true,
                  sessionId: "provider-session",
                  agent: { promptCacheKey: undefined, sessionId: "provider-session", state: { isStreaming: true } },
                },
              },
            ],
          }),
        },
      },
      registerProvider() {},
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
      setLabel() {},
    } as unknown as ExtensionAPI;
    await byteplusCodexProvider(pi, {
      agentDir,
      env: {},
      ompVersion: "17.2.15",
      compactionDependencies: {
        compact: async () => ({
          item: { type: "compaction_summary" },
          replacementHistory: [{ type: "compaction_summary" }],
          usedTokens: 0,
          retainedImageCount: 0,
        }),
      },
    });
    const context = {
      model: { provider: "byteplus-gateway", id: "gpt-codex-test", api: "openai-codex-responses" },
      sessionManager,
      modelRegistry: { getApiKey: async () => "test-key" },
    } as unknown as ExtensionContext;
    const compactEvent = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "kept",
        tokensBefore: 1000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, remoteEnabled: true, remoteStreamingV2Enabled: true },
      },
      branchEntries: [],
      signal: new AbortController().signal,
    } as unknown as SessionBeforeCompactEvent;
    await handlers.get("auto_compaction_start")?.(
      { type: "auto_compaction_start", reason: "overflow", action: "context-full" },
      context,
    );
    await handlers.get("session_before_compact")?.(compactEvent, context);
    await handlers.get("auto_compaction_end")?.(
      { type: "auto_compaction_end", action: "context-full", result: undefined, aborted: true },
      context,
    );

    expect(closed).toEqual(["original"]);
    expect(providerSessionState.has("openai-codex-responses")).toBeFalse();
  });
});

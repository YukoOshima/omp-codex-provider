import { describe, expect, test } from "bun:test";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { CodexCompactionContext, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { getOpenAICodexTransportDetails } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { compactWithGatewayWebSocket, compactionResult, shouldHandleGatewayCompaction } from "../src/compaction.ts";

const MODEL = {
  provider: "byteplus-gateway",
  id: "gpt-test",
  api: "openai-codex-responses",
} as Model;

const PREPARATION: CompactionPreparation = {
  firstKeptEntryId: "entry-2",
  messagesToSummarize: [],
  turnPrefixMessages: [],
  recentMessages: [],
  isSplitTurn: false,
  tokensBefore: 42000,
  previousPreserveData: { unrelated: { keep: true } },
  fileOps: { read: new Set(), written: new Set(), edited: new Set() },
  settings: {
    enabled: true,
    keepRecentTokens: 20000,
    remoteEnabled: true,
    remoteStreamingV2Enabled: true,
  },
};

describe("gateway remote compaction", () => {
  test("handles only the configured BytePlus WebSocket model when remote V2 is enabled", () => {
    expect(shouldHandleGatewayCompaction(MODEL, PREPARATION)).toBeTrue();
    expect(shouldHandleGatewayCompaction({ ...MODEL, provider: "other" }, PREPARATION)).toBeFalse();
    expect(
      shouldHandleGatewayCompaction(MODEL, {
        ...PREPARATION,
        settings: { ...PREPARATION.settings, remoteStreamingV2Enabled: false },
      }),
    ).toBeFalse();
  });

  test("stores gateway compaction_summary as provider-native V2 replay history", () => {
    const summary = { type: "compaction_summary", id: "cmp_1", encrypted_content: "opaque" };
    const result = compactionResult(PREPARATION, MODEL, {
      item: summary,
      replacementHistory: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "latest" }] },
        summary,
      ],
      usedTokens: 1234,
      usage: { inputTokens: 1234, outputTokens: 56, totalTokens: 1290 },
      retainedImageCount: 0,
    });

    expect(result).toMatchObject({
      summary: expect.stringContaining("Retained 1234 tokens"),
      shortSummary: "Remote compaction",
      firstKeptEntryId: "entry-2",
      tokensBefore: 42000,
      preserveData: {
        unrelated: { keep: true },
        openaiRemoteCompaction: {
          version: "v2",
          provider: "byteplus-gateway",
          usedTokens: 1234,
          replacementHistory: expect.arrayContaining([summary]),
        },
      },
    });
  });

  test("falls back from a failed native WebSocket handshake to SSE on the exact response route", async () => {
    const route = "/native/codex/responses";
    const summary = { type: "compaction_summary", id: "cmp_fallback", encrypted_content: "opaque" };
    const attempts: Array<{ method: string; path: string; upgrade: string | null }> = [];
    let sseRequestBody: Record<string, unknown> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        attempts.push({
          method: request.method,
          path: url.pathname,
          upgrade: request.headers.get("upgrade"),
        });
        if (url.pathname !== route) return new Response("unexpected route", { status: 404 });
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return new Response("WebSocket unavailable", { status: 426 });
        }
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        sseRequestBody = (await request.json()) as Record<string, unknown>;
        const events = [
          { type: "response.output_item.done", item: summary },
          {
            type: "response.completed",
            response: {
              id: "resp_fallback",
              status: "completed",
              usage: { input_tokens: 321, output_tokens: 12, total_tokens: 333 },
            },
          },
        ];
        return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const previousWebSocketPreference = process.env.PI_CODEX_WEBSOCKET;
    process.env.PI_CODEX_WEBSOCKET = "1";
    const providerSessionState = new Map<string, ProviderSessionState>();
    const codexCompaction: CodexCompactionContext = {
      operationId: "compaction-operation-test",
      trigger: "manual",
      reason: "user_requested",
      phase: "standalone_turn",
      strategy: "memento",
    };
    const sessionId = "compaction-fallback-session";
    const model = {
      ...MODEL,
      name: "Compaction fallback test",
      baseUrl: new URL("/native/codex", server.url).toString(),
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
      thinking: { mode: "effort", efforts: ["high"], defaultLevel: "high" },
      compat: {},
      preferWebsockets: true,
    } as unknown as Model<"openai-codex-responses">;
    const preparation: CompactionPreparation = {
      ...PREPARATION,
      messagesToSummarize: [{ role: "user", content: "Compact this history", timestamp: 1 }],
    };

    try {
      const outcome = await compactWithGatewayWebSocket(preparation, model, {
        apiKey: "local-test-key",
        signal: AbortSignal.timeout(5_000),
        sessionId,
        promptCacheKey: "compaction-cache-key",
        providerSessionState,
        preferWebsockets: true,
        codexCompaction,
      });

      expect(attempts).toEqual([
        { method: "GET", path: route, upgrade: "websocket" },
        { method: "POST", path: route, upgrade: null },
      ]);
      const turnMetadataJson = (sseRequestBody?.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"];
      expect(typeof turnMetadataJson).toBe("string");
      const turnMetadata = JSON.parse(turnMetadataJson as string) as Record<string, unknown>;
      expect(sseRequestBody).toMatchObject({
        model: MODEL.id,
        stream: true,
        store: false,
        prompt_cache_key: "compaction-cache-key",
        reasoning: { effort: "high", summary: "auto" },
      });
      expect(turnMetadata).toMatchObject({
        request_kind: "compaction",
        compaction: {
          trigger: "manual",
          reason: "user_requested",
          implementation: "responses_compaction_v2",
          phase: "standalone_turn",
          strategy: "memento",
        },
      });
      const input = sseRequestBody?.input;
      expect(Array.isArray(input)).toBeTrue();
      expect(Array.isArray(input) ? input.at(-1) : undefined).toEqual({ type: "compaction_trigger" });
      expect(outcome).toMatchObject({
        item: summary,
        usedTokens: 321,
        usage: { inputTokens: 321, outputTokens: 12, totalTokens: 333 },
      });
      expect(outcome.replacementHistory.at(-1)).toEqual(summary);
      expect(
        getOpenAICodexTransportDetails(model, { sessionId, providerSessionState, preferWebsockets: true }),
      ).toMatchObject({
        lastTransport: "sse",
        websocketDisabled: true,
        fallbackCount: 1,
      });
    } finally {
      for (const state of providerSessionState.values()) state.close();
      providerSessionState.clear();
      server.stop(true);
      if (previousWebSocketPreference === undefined) delete process.env.PI_CODEX_WEBSOCKET;
      else process.env.PI_CODEX_WEBSOCKET = previousWebSocketPreference;
    }
  });
});

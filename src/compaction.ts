import {
  buildCompactionV2ReplacementHistory,
  buildOpenAiNativeHistory,
  computeFileLists,
  defaultConvertToLlm,
  getCompactionV2PreserveData,
  SUMMARIZATION_SYSTEM_PROMPT,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionV2Usage,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, Model } from "@oh-my-pi/pi-ai";

const COMPACTION_TRIGGER = { type: "compaction_trigger" } as const;
const PROVIDER_ID = "byteplus-gateway";
const CODEX_API = "openai-codex-responses";
const FIRST_EVENT_TIMEOUT_MS = 100_000;
const IDLE_TIMEOUT_MS = 300_000;

export interface GatewayCompactionOptions {
  apiKey: string;
  signal?: AbortSignal;
  sessionId?: string;
  promptCacheKey?: string;
  customInstructions?: string;
}

export interface GatewayCompactionOutcome {
  item: Record<string, unknown>;
  replacementHistory: Array<Record<string, unknown>>;
  usedTokens: number;
  usage?: CompactionV2Usage;
  retainedImageCount: number;
}

function recordAt(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFromEvent(event: Record<string, unknown>): CompactionV2Usage | undefined {
  const response = recordAt(event.response);
  const usage = recordAt(response?.usage);
  if (!usage) return undefined;
  const inputTokens = numberAt(usage.input_tokens);
  const outputTokens = numberAt(usage.output_tokens);
  const totalTokens = numberAt(usage.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined;
  const inputDetails = recordAt(usage.input_tokens_details);
  const outputDetails = recordAt(usage.output_tokens_details);
  const cachedInputTokens = numberAt(inputDetails?.cached_tokens);
  const reasoningOutputTokens = numberAt(outputDetails?.reasoning_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}

function previousReplacementHistory(preparation: CompactionPreparation, model: Model<Api>): Array<Record<string, unknown>> | undefined {
  const previous = getCompactionV2PreserveData(preparation.previousPreserveData);
  return previous?.provider === model.provider ? previous.replacementHistory : undefined;
}

function reasoningFor(model: Model<Api>): { effort: string; summary: string } | undefined {
  if (!model.reasoning) return undefined;
  const requested = model.thinking?.defaultLevel ?? model.thinking?.efforts.at(-1);
  if (!requested) return undefined;
  return { effort: model.thinking?.effortMap?.[requested] ?? requested, summary: "auto" };
}

function inputImageCount(item: Record<string, unknown>): number {
  if (item.type !== "message" || !Array.isArray(item.content)) return 0;
  return item.content.reduce((count, part) => count + (recordAt(part)?.type === "input_image" ? 1 : 0), 0);
}

function exactResponsesUrl(model: Model<Api>): string {
  const url = new URL(model.baseUrl);
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function asWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

async function requestCompactionEvents(
  model: Model<Api>,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const socket = new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => Bun.WebSocket)(
    asWebSocketUrl(exactResponsesUrl(model)),
    {
      headers: {
        ...(model.headers ?? {}),
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "responses_websockets=2026-02-06",
      },
    },
  );
  socket.binaryType = "nodebuffer";
  const events: Record<string, unknown>[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>[]>();
  let settled = false;
  let timeout: NodeJS.Timeout;
  const cleanup = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    socket.close(1000, "failed");
    reject(error);
  };
  const resetTimeout = (ms: number) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fail(new Error("BytePlus compaction WebSocket response timed out")), ms);
  };
  const abort = () => fail(new Error("BytePlus compaction aborted"));
  timeout = setTimeout(() => fail(new Error("BytePlus compaction WebSocket connection timed out")), FIRST_EVENT_TIMEOUT_MS);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  socket.onopen = () => {
    if (settled) return;
    resetTimeout(IDLE_TIMEOUT_MS);
    socket.send(JSON.stringify({ type: "response.create", ...body }));
  };
  socket.onerror = event => {
    let detail = "handshake failed";
    if (event && typeof event === "object" && "message" in event && typeof event.message === "string") {
      detail = event.message;
    }
    fail(new Error(`BytePlus compaction WebSocket error: ${detail}`));
  };
  socket.onclose = event => {
    if (!settled) fail(new Error(`BytePlus compaction WebSocket closed before completion (${event.code})`));
  };
  socket.onmessage = message => {
    try {
      const data = (message as MessageEvent<unknown>).data;
      const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
      const event = JSON.parse(text) as Record<string, unknown>;
      events.push(event);
      resetTimeout(IDLE_TIMEOUT_MS);
      if (event.type === "response.completed" || event.type === "response.done") {
        settled = true;
        cleanup();
        socket.close(1000, "complete");
        resolve(events);
      } else if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
        fail(new Error(`BytePlus compaction failed: ${String(event.type)}`));
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return promise;
}

export async function compactWithGatewayWebSocket(
  preparation: CompactionPreparation,
  model: Model<Api>,
  options: GatewayCompactionOptions,
): Promise<GatewayCompactionOutcome> {
  const messages = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
    ...preparation.recentMessages,
  ];
  const input = buildOpenAiNativeHistory(
    defaultConvertToLlm(messages),
    model,
    previousReplacementHistory(preparation, model),
  );
  if (input.length === 0) throw new Error("BytePlus remote compaction has no provider history to compact");
  const reasoning = reasoningFor(model);
  const body: Record<string, unknown> = {
    model: model.requestModelId ?? model.id,
    input: [...input, COMPACTION_TRIGGER],
    instructions: options.customInstructions?.trim() || SUMMARIZATION_SYSTEM_PROMPT,
    store: false,
    ...(reasoning ? { reasoning, include: ["reasoning.encrypted_content"] } : {}),
    ...(options.promptCacheKey || options.sessionId
      ? { prompt_cache_key: options.promptCacheKey ?? options.sessionId }
      : {}),
  };
  const events = await requestCompactionEvents(model, body, options.apiKey, options.signal);
  let completed = false;
  let usage: CompactionV2Usage | undefined;
  const items: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.type === "response.output_item.done") {
      const item = recordAt(event.item);
      if (item) items.push(item);
      continue;
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      completed = true;
      usage = usageFromEvent(event);
      continue;
    }
    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
      const error = recordAt(event.error) ?? recordAt(recordAt(event.response)?.error);
      throw new Error(
        `BytePlus remote compaction failed${typeof error?.message === "string" ? `: ${error.message}` : ""}`,
      );
    }
  }
  if (!completed) throw new Error("BytePlus remote compaction closed before response.completed");
  const compactionItems = items.filter(item => item.type === "compaction" || item.type === "compaction_summary");
  if (compactionItems.length !== 1) {
    throw new Error(
      `BytePlus remote compaction expected one compaction item, got ${compactionItems.length} from ${items.length} output items`,
    );
  }
  const item = compactionItems[0]!;
  const retainedBudget = preparation.settings.v2RetainedMessageBudget;
  const replacement = buildCompactionV2ReplacementHistory(input, item, retainedBudget);
  return {
    item,
    replacementHistory: replacement.replacementHistory,
    retainedImageCount:
      replacement.retainedImageCount ?? replacement.replacementHistory.reduce((sum, entry) => sum + inputImageCount(entry), 0),
    usedTokens: usage?.inputTokens ?? 0,
    usage,
  };
}

export function compactionResult(
  preparation: CompactionPreparation,
  model: Model<Api>,
  outcome: GatewayCompactionOutcome,
): CompactionResult {
  const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
  return {
    summary:
      "Remote compaction preserved provider-native history for this session." +
      (outcome.usedTokens > 0 ? ` Retained ${outcome.usedTokens} tokens in the provider replay payload.` : ""),
    shortSummary: "Remote compaction",
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles, modifiedFiles },
    preserveData: {
      ...(preparation.previousPreserveData ?? {}),
      openaiRemoteCompaction: {
        version: "v2",
        provider: model.provider,
        replacementHistory: outcome.replacementHistory,
        usedTokens: outcome.usedTokens,
        usage: outcome.usage,
        retainedImageCount: outcome.retainedImageCount,
      },
    },
  };
}

export function shouldHandleGatewayCompaction(model: Model<Api> | undefined, preparation: CompactionPreparation): boolean {
  return (
    model?.provider === PROVIDER_ID &&
    model.api === CODEX_API &&
    preparation.settings.remoteEnabled !== false &&
    preparation.settings.remoteStreamingV2Enabled !== false
  );
}

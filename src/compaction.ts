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
import type { Api, CodexCompactionContext, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import {
  createOpenAICodexCompactionRequestContext,
  openCodexCompactionEventStream,
  type OpenAICodexCompactionBody,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";

const COMPACTION_TRIGGER = { type: "compaction_trigger" } as const;
const PROVIDER_ID = "byteplus-gateway";
const CODEX_API = "openai-codex-responses";

export interface GatewayCompactionOptions {
  apiKey: string;
  signal?: AbortSignal;
  sessionId?: string;
  promptCacheKey?: string;
  customInstructions?: string;
  providerSessionState?: Map<string, ProviderSessionState>;
  preferWebsockets?: boolean;
  codexCompaction: CodexCompactionContext;
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

export async function compactWithGatewayWebSocket(
  preparation: CompactionPreparation,
  model: Model<Api>,
  options: GatewayCompactionOptions,
): Promise<GatewayCompactionOutcome> {
  if (model.api !== CODEX_API) {
    throw new Error(`BytePlus remote compaction requires ${CODEX_API}, got ${model.api}`);
  }
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
  const body: OpenAICodexCompactionBody = {
    model: model.requestModelId ?? model.id,
    input: [...input, COMPACTION_TRIGGER],
    instructions: options.customInstructions?.trim() || SUMMARIZATION_SYSTEM_PROMPT,
    stream: true,
    store: false,
    ...(reasoning ? { reasoning, include: ["reasoning.encrypted_content"] } : {}),
    ...(options.promptCacheKey || options.sessionId
      ? { prompt_cache_key: options.promptCacheKey ?? options.sessionId }
      : {}),
  };
  const events = await openCodexCompactionEventStream(model as Model<"openai-codex-responses">, body, {
    apiKey: options.apiKey,
    signal: options.signal,
    sessionId: options.sessionId,
    providerSessionState: options.providerSessionState,
    preferWebsockets: options.preferWebsockets,
    codexCompaction: createOpenAICodexCompactionRequestContext({
      context: options.codexCompaction,
      implementation: "responses_compaction_v2",
    }),
  });
  let completed = false;
  let usage: CompactionV2Usage | undefined;
  const items: Record<string, unknown>[] = [];
  for await (const event of events) {
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

import { describe, expect, test } from "bun:test";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { compactionResult, shouldHandleGatewayCompaction } from "../src/compaction.ts";

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
});

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-coding-agent";
import { compactWithGatewayWebSocket, compactionResult, shouldHandleGatewayCompaction } from "../src/compaction.ts";
import { loadProviderConfig, providerConfigPath } from "../src/config.ts";
import { createProviderRegistration, PROVIDER_ID } from "../src/provider.ts";
import { assertSupportedOmpVersion } from "../src/version.ts";

export interface RegisterProviderOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  ompVersion?: string;
}

export async function registerConfiguredProvider(
  pi: Pick<ExtensionAPI, "registerProvider">,
  options: RegisterProviderOptions = {},
): Promise<void> {
  assertSupportedOmpVersion(options.ompVersion ?? VERSION);
  const config = await loadProviderConfig(
    providerConfigPath(options.agentDir ?? getAgentDir()),
    options.env ?? process.env,
  );
  const registration = createProviderRegistration(config);
  pi.registerProvider(PROVIDER_ID, registration as ProviderConfig);
}

export type CompactionDependencies = {
  compact: typeof compactWithGatewayWebSocket;
};

export function createGatewayCompactionHandler(
  dependencies: CompactionDependencies = { compact: compactWithGatewayWebSocket },
): (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<SessionBeforeCompactResult | void> {
  return async (event, ctx) => {
    const model = ctx.model;
    if (!model || !shouldHandleGatewayCompaction(model, event.preparation)) return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal: event.signal });
      if (!apiKey) throw new Error(`No API key found for ${model.provider}/${model.id}`);
      const timeoutSignal = AbortSignal.timeout(29_000);
      const signal = AbortSignal.any([event.signal, timeoutSignal]);
      const outcome = await dependencies.compact(event.preparation, model, {
        apiKey,
        signal,
        sessionId,
        promptCacheKey: sessionId,
        customInstructions: event.customInstructions,
      });
      return { compaction: compactionResult(event.preparation, model, outcome) };
    } catch {
      return { cancel: true };
    }
  };
}

export default async function byteplusCodexProvider(pi: ExtensionAPI): Promise<void> {
  await registerConfiguredProvider(pi);
  pi.on("session_before_compact", createGatewayCompactionHandler());
  pi.setLabel("BytePlus Codex Provider");
}

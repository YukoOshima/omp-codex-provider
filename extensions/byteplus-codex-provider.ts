import type {
  AutoCompactionStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-coding-agent";
import type { CodexCompactionContext, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { resetOpenAICodexHistoryAfterCompaction } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { compactWithGatewayWebSocket, compactionResult, shouldHandleGatewayCompaction } from "../src/compaction.ts";
import { loadProviderConfig, providerConfigPath } from "../src/config.ts";
import {
  CODEX_PROVIDER_ID,
  createCodexSearchProviderRegistration,
  createProviderRegistration,
  PROVIDER_ID,
} from "../src/provider.ts";
import { assertSupportedOmpVersion } from "../src/version.ts";

const WEB_SEARCH_MODEL_ENV = "PI_CODEX_WEB_SEARCH_MODEL";
const CODEX_SESSION_STATE_KEY = "openai-codex-responses";

interface WebSearchModelLeaseState {
  model: string;
  owners: number;
  previous: string | undefined;
}

const webSearchModelLeases = new WeakMap<NodeJS.ProcessEnv, WebSearchModelLeaseState>();

function acquireWebSearchModel(env: NodeJS.ProcessEnv, model: string): () => void {
  const existing = webSearchModelLeases.get(env);
  if (existing) {
    if (existing.model !== model) {
      throw new Error(`Conflicting ${WEB_SEARCH_MODEL_ENV} values: ${existing.model} and ${model}`);
    }
    existing.owners++;
  } else {
    webSearchModelLeases.set(env, { model, owners: 1, previous: env[WEB_SEARCH_MODEL_ENV] });
    env[WEB_SEARCH_MODEL_ENV] = model;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const lease = webSearchModelLeases.get(env);
    if (!lease || lease.model !== model) return;
    lease.owners--;
    if (lease.owners > 0) return;
    webSearchModelLeases.delete(env);
    if (env[WEB_SEARCH_MODEL_ENV] !== model) return;
    if (lease.previous === undefined) delete env[WEB_SEARCH_MODEL_ENV];
    else env[WEB_SEARCH_MODEL_ENV] = lease.previous;
  };
}

export interface RegisterProviderOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  ompVersion?: string;
}

export async function registerConfiguredProvider(
  pi: Pick<ExtensionAPI, "registerProvider">,
  options: RegisterProviderOptions = {},
): Promise<() => void> {
  assertSupportedOmpVersion(options.ompVersion ?? VERSION);
  const env = options.env ?? process.env;
  const config = await loadProviderConfig(providerConfigPath(options.agentDir ?? getAgentDir()), env);
  const releaseWebSearchModel = config.webSearchModel
    ? acquireWebSearchModel(env, config.webSearchModel)
    : () => {};
  try {
    pi.registerProvider(PROVIDER_ID, createProviderRegistration(config) as ProviderConfig);
    const codexSearchRegistration = createCodexSearchProviderRegistration(config);
    if (codexSearchRegistration) {
      pi.registerProvider(CODEX_PROVIDER_ID, codexSearchRegistration as ProviderConfig);
    }
    return releaseWebSearchModel;
  } catch (error) {
    releaseWebSearchModel();
    throw error;
  }
}

export interface LiveCompactionSession {
  providerSessionState: Map<string, ProviderSessionState>;
  preferWebsockets: boolean | undefined;
  sessionId: string;
  promptCacheKey: string;
  isStreaming: boolean;
}

export type CompactionDependencies = {
  compact: typeof compactWithGatewayWebSocket;
  resolveSession(ctx: ExtensionContext): LiveCompactionSession;
  getAutoCompaction(): AutoCompactionStartEvent | undefined;
  abortPendingState(): void;
  protectSessionState(session: LiveCompactionSession, compaction: CodexCompactionContext): void;
};

function createCompactionContext(
  autoCompaction: AutoCompactionStartEvent | undefined,
  session: LiveCompactionSession,
): CodexCompactionContext {
  if (!autoCompaction) {
    return {
      operationId: crypto.randomUUID(),
      trigger: "manual",
      reason: "user_requested",
      phase: "standalone_turn",
      strategy: "memento",
    };
  }
  const phase =
    autoCompaction.reason === "idle"
      ? "standalone_turn"
      : autoCompaction.reason === "overflow" || autoCompaction.reason === "incomplete" || session.isStreaming
        ? "mid_turn"
        : "pre_turn";
  return {
    operationId: crypto.randomUUID(),
    trigger: "auto",
    reason: "context_limit",
    phase,
    strategy: "memento",
  };
}

export function createGatewayCompactionHandler(
  dependencies: CompactionDependencies,
): (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<SessionBeforeCompactResult | void> {
  return async (event, ctx) => {
    dependencies.abortPendingState();
    const model = ctx.model;
    if (!model || !shouldHandleGatewayCompaction(model, event.preparation)) return;
    try {
      const session = dependencies.resolveSession(ctx);
      const apiKey = await ctx.modelRegistry.getApiKey(model, session.sessionId, { signal: event.signal });
      if (!apiKey) throw new Error(`No API key found for ${model.provider}/${model.id}`);
      const timeoutSignal = AbortSignal.timeout(29_000);
      const signal = AbortSignal.any([event.signal, timeoutSignal]);
      const codexCompaction = createCompactionContext(dependencies.getAutoCompaction(), session);
      const outcome = await dependencies.compact(event.preparation, model, {
        apiKey,
        signal,
        sessionId: session.sessionId,
        promptCacheKey: session.promptCacheKey,
        customInstructions: event.customInstructions,
        providerSessionState: session.providerSessionState,
        preferWebsockets: session.preferWebsockets,
        codexCompaction,
      });
      const compaction = compactionResult(event.preparation, model, outcome);
      dependencies.protectSessionState(session, codexCompaction);
      return { compaction };
    } catch {
      return { cancel: true };
    }
  };
}

interface PendingCompactionState {
  session: LiveCompactionSession;
  compaction: CodexCompactionContext;
  original: ProviderSessionState;
  guard: ProviderSessionState;
}

interface CompactionStateBridge {
  protect(session: LiveCompactionSession, compaction: CodexCompactionContext): void;
  commit(): void;
  abort(): void;
}

function createCompactionStateBridge(): CompactionStateBridge {
  let pending: PendingCompactionState | undefined;

  const clear = (): PendingCompactionState | undefined => {
    const current = pending;
    pending = undefined;
    return current;
  };

  const abort = (): void => {
    const current = clear();
    if (!current) return;
    const mapped = current.session.providerSessionState.get(CODEX_SESSION_STATE_KEY);
    if (mapped === current.guard || mapped === current.original) {
      current.session.providerSessionState.delete(CODEX_SESSION_STATE_KEY);
    }
    current.original.close();
  };

  return {
    protect(session, compaction) {
      if (pending) abort();
      const original = session.providerSessionState.get(CODEX_SESSION_STATE_KEY);
      if (!original) throw new Error("OMP did not create Codex provider session state for remote compaction");
      const guard = new Proxy(original, {
        get(target, property, receiver) {
          return property === "close" ? () => {} : Reflect.get(target, property, receiver);
        },
      });
      session.providerSessionState.set(CODEX_SESSION_STATE_KEY, guard);
      pending = { session, compaction, original, guard };
    },
    commit() {
      const current = clear();
      if (!current) return;
      const mapped = current.session.providerSessionState.get(CODEX_SESSION_STATE_KEY);
      if (mapped !== undefined && mapped !== current.guard && mapped !== current.original) {
        current.original.close();
        return;
      }
      current.session.providerSessionState.set(CODEX_SESSION_STATE_KEY, current.original);
      resetOpenAICodexHistoryAfterCompaction({
        providerSessionState: current.session.providerSessionState,
        sessionId: current.session.sessionId,
        compaction: current.compaction,
      });
    },
    abort,
  };
}

function resolveLiveCompactionSession(pi: ExtensionAPI, ctx: ExtensionContext): LiveCompactionSession {
  const sessions = pi.pi.AgentRegistry.global()
    .list()
    .flatMap(ref => (ref.session?.sessionManager === ctx.sessionManager ? [ref.session] : []));
  if (sessions.length !== 1) {
    throw new Error(`Expected one live OMP session for remote compaction, found ${sessions.length}`);
  }
  const session = sessions[0]!;
  const sessionId = session.sessionId;
  return {
    providerSessionState: session.providerSessionState,
    preferWebsockets: session.preferWebsockets,
    sessionId,
    promptCacheKey: session.agent.promptCacheKey ?? session.agent.sessionId ?? sessionId,
    isStreaming: session.agent.state.isStreaming,
  };
}

export interface BytePlusCodexProviderOptions extends RegisterProviderOptions {
  compactionDependencies?: Partial<Pick<CompactionDependencies, "compact" | "resolveSession">>;
}

export default async function byteplusCodexProvider(
  pi: ExtensionAPI,
  options: BytePlusCodexProviderOptions = {},
): Promise<void> {
  const releaseWebSearchModel = await registerConfiguredProvider(pi, options);
  let autoCompaction: AutoCompactionStartEvent | undefined;
  const stateBridge = createCompactionStateBridge();
  try {
    const dependencies: CompactionDependencies = {
      compact: options.compactionDependencies?.compact ?? compactWithGatewayWebSocket,
      resolveSession: options.compactionDependencies?.resolveSession ?? (ctx => resolveLiveCompactionSession(pi, ctx)),
      getAutoCompaction: () => autoCompaction,
      abortPendingState: () => stateBridge.abort(),
      protectSessionState: (session, compaction) => stateBridge.protect(session, compaction),
    };
    pi.on("auto_compaction_start", event => {
      autoCompaction = event;
    });
    pi.on("auto_compaction_end", () => {
      autoCompaction = undefined;
      stateBridge.abort();
    });
    pi.on("session_before_compact", createGatewayCompactionHandler(dependencies));
    pi.on("session_compact", event => {
      if (event.fromExtension) stateBridge.commit();
    });
    pi.on("turn_start", () => {
      stateBridge.abort();
    });
    pi.on("session_shutdown", () => {
      autoCompaction = undefined;
      releaseWebSearchModel();
      stateBridge.abort();
    });
    pi.setLabel("BytePlus Codex Provider");
  } catch (error) {
    releaseWebSearchModel();
    throw error;
  }
}

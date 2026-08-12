import { stat } from "node:fs/promises";
import * as path from "node:path";

export const CONFIG_FILE_NAME = "omp-codex-provider.local.json";

const ROOT_KEYS: Record<string, true> = {
  version: true,
  apiKey: true,
  apiKeyEnv: true,
  webSearchModel: true,
  models: true,
};
const MODEL_KEYS: Record<string, true> = {
  id: true,
  name: true,
  api: true,
  baseUrl: true,
  reasoning: true,
  input: true,
  supportsTools: true,
  contextWindow: true,
  maxTokens: true,
  cost: true,
  thinking: true,
};
const COST_KEYS: Record<string, true> = { input: true, output: true, cacheRead: true, cacheWrite: true };
const THINKING_KEYS: Record<string, true> = {
  mode: true,
  efforts: true,
  defaultLevel: true,
  supportsDisplay: true,
};
const SUPPORTED_APIS: Record<SupportedApi, true> = {
  "openai-codex-responses": true,
  "anthropic-messages": true,
};
const THINKING_MODES: Record<ThinkingMode, true> = {
  effort: true,
  budget: true,
  "google-level": true,
  "anthropic-adaptive": true,
  "anthropic-budget-effort": true,
};
const EFFORTS: Record<Effort, true> = {
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};
const INPUT_TYPES: Record<InputType, true> = { text: true, image: true };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SupportedApi = "openai-codex-responses" | "anthropic-messages";
export type ThinkingMode = "effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort";
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type InputType = "text" | "image";

export interface ProviderCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProviderThinking {
  mode: ThinkingMode;
  efforts: Effort[];
  defaultLevel?: Effort;
  supportsDisplay?: boolean;
}

export interface ProviderModel {
  id: string;
  name: string;
  api: SupportedApi;
  baseUrl: string;
  reasoning: boolean;
  input: InputType[];
  supportsTools?: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: ProviderCost;
  thinking?: ProviderThinking;
}

export interface ProviderFileConfig {
  version: 1;
  /** Literal API key or environment-variable name, ready for OMP resolution. */
  apiKey: string;
  /** Configured Codex model exposed to OMP's built-in Codex web search provider. */
  webSearchModel?: string;
  models: ProviderModel[];
}

export function providerConfigPath(agentDir: string): string {
  return path.join(agentDir, CONFIG_FILE_NAME);
}

function fail(location: string, message: string): never {
  throw new Error(`${CONFIG_FILE_NAME}: ${location} ${message}`);
}

function objectAt(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(location, "must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Readonly<Record<string, true>>, location: string): void {
  const unknown = Object.keys(value).filter(key => allowed[key] !== true);
  if (unknown.length > 0) fail(location, `contains unknown field(s): ${unknown.join(", ")}`);
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(location, "must be a non-empty string");
  if (value !== value.trim()) fail(location, "must not have leading or trailing whitespace");
  return value;
}

function booleanAt(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") fail(location, "must be a boolean");
  return value;
}

function positiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(location, "must be a positive safe integer");
  }
  return value;
}

function nonNegativeNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(location, "must be a finite non-negative number");
  }
  return value;
}

function oneOf<T extends string>(value: unknown, values: Readonly<Record<T, true>>, location: string): T {
  if (typeof value !== "string" || values[value as T] !== true) {
    fail(location, `must be one of: ${Object.keys(values).join(", ")}`);
  }
  return value as T;
}

function uniqueStringArray<T extends string>(value: unknown, values: Readonly<Record<T, true>>, location: string): T[] {
  if (!Array.isArray(value) || value.length === 0) fail(location, "must be a non-empty array");
  const result = value.map((entry, index) => oneOf(entry, values, `${location}[${index}]`));
  if (new Set(result).size !== result.length) fail(location, "must not contain duplicates");
  return result;
}

function absoluteHttpsUrl(value: unknown, location: string, api: SupportedApi): string {
  const raw = nonEmptyString(value, location);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(location, "must be an absolute URL");
  }
  if (url.protocol !== "https:") fail(location, "must use https");
  if (url.username || url.password) fail(location, "must not contain credentials");
  if (url.hash) fail(location, "must not contain a fragment");
  if (url.toString().replace(/\/$/, "") !== raw.replace(/\/$/, "")) {
    fail(location, "must be a normalized absolute URL");
  }
  const normalized = raw.replace(/\/$/, "");
  if (api === "openai-codex-responses") {
    if (!url.pathname.replace(/\/$/, "").endsWith("/responses")) {
      fail(location, "must point to the exact /responses route for openai-codex-responses");
    }
    if (url.search !== "?omp_codex_suffix=") {
      fail(location, "must end with ?omp_codex_suffix= for openai-codex-responses");
    }
  } else if (url.search) {
    fail(location, "must not contain a query");
  }
  return normalized;
}

function parseCost(value: unknown, location: string): ProviderCost {
  const object = objectAt(value, location);
  rejectUnknownKeys(object, COST_KEYS, location);
  return {
    input: nonNegativeNumber(object.input, `${location}.input`),
    output: nonNegativeNumber(object.output, `${location}.output`),
    cacheRead: nonNegativeNumber(object.cacheRead, `${location}.cacheRead`),
    cacheWrite: nonNegativeNumber(object.cacheWrite, `${location}.cacheWrite`),
  };
}

function parseThinking(value: unknown, location: string, api: SupportedApi): ProviderThinking {
  const object = objectAt(value, location);
  rejectUnknownKeys(object, THINKING_KEYS, location);
  const mode = oneOf(object.mode, THINKING_MODES, `${location}.mode`);
  if (api === "openai-codex-responses" && mode !== "effort") {
    fail(`${location}.mode`, "must be effort for openai-codex-responses");
  }
  if (api === "anthropic-messages" && mode !== "anthropic-adaptive" && mode !== "anthropic-budget-effort") {
    fail(`${location}.mode`, "must be an Anthropic thinking mode for anthropic-messages");
  }
  const efforts = uniqueStringArray(object.efforts, EFFORTS, `${location}.efforts`);
  const defaultLevel =
    object.defaultLevel === undefined ? undefined : oneOf(object.defaultLevel, EFFORTS, `${location}.defaultLevel`);
  if (defaultLevel !== undefined && !efforts.includes(defaultLevel)) {
    fail(`${location}.defaultLevel`, "must also appear in efforts");
  }
  return {
    mode,
    efforts,
    ...(defaultLevel === undefined ? {} : { defaultLevel }),
    ...(object.supportsDisplay === undefined
      ? {}
      : { supportsDisplay: booleanAt(object.supportsDisplay, `${location}.supportsDisplay`) }),
  };
}

function parseModel(value: unknown, index: number): ProviderModel {
  const location = `models[${index}]`;
  const object = objectAt(value, location);
  rejectUnknownKeys(object, MODEL_KEYS, location);
  const api = oneOf(object.api, SUPPORTED_APIS, `${location}.api`);
  const reasoning = booleanAt(object.reasoning, `${location}.reasoning`);
  const thinking = object.thinking === undefined ? undefined : parseThinking(object.thinking, `${location}.thinking`, api);
  if (!reasoning && thinking !== undefined) fail(`${location}.thinking`, "requires reasoning=true");
  return {
    id: nonEmptyString(object.id, `${location}.id`),
    name: nonEmptyString(object.name, `${location}.name`),
    api,
    baseUrl: absoluteHttpsUrl(object.baseUrl, `${location}.baseUrl`, api),
    reasoning,
    input: uniqueStringArray(object.input, INPUT_TYPES, `${location}.input`),
    ...(object.supportsTools === undefined
      ? {}
      : { supportsTools: booleanAt(object.supportsTools, `${location}.supportsTools`) }),
    contextWindow: positiveInteger(object.contextWindow, `${location}.contextWindow`),
    maxTokens: positiveInteger(object.maxTokens, `${location}.maxTokens`),
    cost: parseCost(object.cost, `${location}.cost`),
    ...(thinking === undefined ? {} : { thinking }),
  };
}

export function parseProviderConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): ProviderFileConfig {
  const object = objectAt(value, "root");
  rejectUnknownKeys(object, ROOT_KEYS, "root");
  if (object.version !== 1) fail("version", "must be exactly 1");

  const hasLiteralKey = object.apiKey !== undefined;
  const hasEnvKey = object.apiKeyEnv !== undefined;
  if (hasLiteralKey === hasEnvKey) fail("root", "must contain exactly one of apiKey or apiKeyEnv");

  let apiKey: string;
  if (hasLiteralKey) {
    apiKey = nonEmptyString(object.apiKey, "apiKey");
    if (env[apiKey] !== undefined) fail("apiKey", "is ambiguous with an existing environment-variable name");
  } else {
    const apiKeyEnv = nonEmptyString(object.apiKeyEnv, "apiKeyEnv");
    if (!ENV_NAME.test(apiKeyEnv)) fail("apiKeyEnv", "must be a valid environment-variable name");
    if (!env[apiKeyEnv]?.trim()) fail("apiKeyEnv", `${apiKeyEnv} is not set or is empty`);
    apiKey = apiKeyEnv;
  }

  if (!Array.isArray(object.models) || object.models.length === 0) fail("models", "must be a non-empty array");
  const models = object.models.map(parseModel);
  const duplicateIds = models.filter((model, index) => models.findIndex(candidate => candidate.id === model.id) !== index);
  if (duplicateIds.length > 0) fail("models", `contains duplicate id(s): ${[...new Set(duplicateIds.map(model => model.id))].join(", ")}`);
  if (!models.some(model => model.api === "openai-codex-responses")) {
    fail("models", "must contain at least one openai-codex-responses model");
  }
  const webSearchModel =
    object.webSearchModel === undefined ? undefined : nonEmptyString(object.webSearchModel, "webSearchModel");
  if (
    webSearchModel !== undefined &&
    !models.some(model => model.id === webSearchModel && model.api === "openai-codex-responses")
  ) {
    fail("webSearchModel", "must name a configured openai-codex-responses model");
  }

  return {
    version: 1,
    apiKey,
    ...(webSearchModel === undefined ? {} : { webSearchModel }),
    models,
  };
}

export async function loadProviderConfig(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderFileConfig> {
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") throw new Error(`${CONFIG_FILE_NAME}: configuration file not found at ${filePath}`);
    throw new Error(`${CONFIG_FILE_NAME}: cannot read ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${CONFIG_FILE_NAME}: invalid JSON in ${filePath}`, { cause: error });
  }

  const config = parseProviderConfig(parsed, env);
  if ("apiKey" in objectAt(parsed, "root") && process.platform !== "win32") {
    const mode = (await stat(filePath)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(`${CONFIG_FILE_NAME}: ${filePath} contains apiKey and must have mode 0600`);
    }
  }
  return config;
}

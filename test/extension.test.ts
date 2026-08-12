import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { registerConfiguredProvider } from "../extensions/byteplus-codex-provider.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function writeConfig(): Promise<string> {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "omp-codex-provider-extension-"));
  temporaryDirectories.push(agentDir);
  const configPath = path.join(agentDir, "omp-codex-provider.local.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      apiKey: "literal-test-key",
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

    await registerConfiguredProvider(pi, { agentDir, env: {}, ompVersion: "17.2.15" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("byteplus-gateway");
    expect(calls[0]?.[1].models?.[0]?.api).toBe("openai-codex-responses");
  });

  test("fails before registration on an unsupported OMP version", async () => {
    const agentDir = await writeConfig();
    let registered = false;
    const pi: Pick<ExtensionAPI, "registerProvider"> = {
      registerProvider() {
        registered = true;
      },
    };

    await expect(registerConfiguredProvider(pi, { agentDir, env: {}, ompVersion: "17.2.3" })).rejects.toThrow(
      "requires OMP >=17.2.4 <18",
    );
    expect(registered).toBeFalse();
  });
});

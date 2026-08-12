# OMP Codex Provider

OMP extension for a BytePlus Gateway that exposes the OpenAI Responses protocol at an exact `/responses` route rather than OMP's default `/codex/responses` route.

It replaces the `byteplus-gateway` model catalog from one strict local file and provides:

- native OMP `openai-codex-responses` turns over WebSocket, including OMP's built-in SSE fallback
- tolerant remote compaction over the same WebSocket-first Codex transport, including gateways that return `compaction_summary`
- optional BytePlus-backed Web Search through OMP's built-in `codex` search provider over HTTP/SSE
- mixed Codex and `anthropic-messages` models under one provider

## Requirements

- OMP `>=17.2.15 <18`
- Bun `>=1.3.14`
- an HTTPS/WSS gateway implementing the Responses stream and `compaction_trigger`

## Install

Install a tagged release, then restart OMP:

```bash
omp plugin install github:YukoOshima/omp-codex-provider#v0.1.2
```

## Configure

Copy `config.example.json` to the active OMP agent directory as:

```text
omp-codex-provider.local.json
```

The default path is:

```text
~/.omp/agent/omp-codex-provider.local.json
```

Named profiles, XDG configuration, and `PI_CODING_AGENT_DIR` are respected because the extension resolves the active directory through OMP's `getAgentDir()`.

The local file is ignored by Git. It must contain:

- `version: 1`
- exactly one of `apiKey` or `apiKeyEnv`
- a complete `models` array for `byteplus-gateway`
- complete model metadata and an absolute HTTPS `baseUrl` for every model
- at least one `openai-codex-responses` model
- optional `webSearchModel`, naming one configured `openai-codex-responses` model

If `apiKey` is literal, the file must have mode `0600` on Unix. `apiKeyEnv` must name a populated environment variable at OMP startup.

### Codex endpoint format

For each `openai-codex-responses` model, set `baseUrl` to the gateway's exact Responses endpoint followed by the fixed empty query parameter:

```json
"baseUrl": "https://gateway.example.com/p9091/v1/responses?omp_codex_suffix="
```

OMP appends `/codex/responses` to Codex base URLs. The fixed parameter contains that suffix inside the query instead of the path, so OMP connects to:

```text
wss://gateway.example.com/p9091/v1/responses?omp_codex_suffix=/codex/responses
```

The BytePlus Gateway ignores the unknown query parameter while receiving the request on the exact `/responses` path. The extension validates this exact form; arbitrary query strings are rejected.

The extension keeps the model on OMP's built-in `openai-codex-responses` API and injects endpoint-free V2 metadata:

```json
{
  "remoteCompaction": {
    "enabled": true,
    "api": "openai-codex-responses",
    "v2StreamingEnabled": true,
    "model": "<model id>"
  }
}
```

Ordinary agent turns therefore retain OMP's native Codex request builder, decoder, WebSocket pooling, retry behavior, prewarming, and SSE fallback. Remote compaction also uses that native WebSocket-first transport, including its retry and SSE fallback policy, while tolerantly accepting either `compaction` or the Gateway's `compaction_summary` output item.

### Web Search

Set `webSearchModel` to the ID of a configured `openai-codex-responses` model to route OMP's existing `codex` Web Search provider through BytePlus. The extension installs a provider-only `openai-codex` transport override using that model's gateway URL and the same API-key source, then sets `PI_CODEX_WEB_SEARCH_MODEL` to select it. It does not replace or register a `web_search` tool.

Web Search uses OMP's built-in Codex search implementation, which sends a hosted `web_search` Responses request over HTTP/SSE. This is intentionally independent of ordinary agent turns and remote compaction, which remain WebSocket-first with native SSE fallback. Leave `webSearchModel` unset to avoid any `openai-codex` override and preserve the existing Web Search configuration.

Enable WebSockets and remote compaction in the active OMP `config.yml`:

```yaml
providers:
  openaiWebsockets: on
  webSearchOrder: [codex]

compaction:
  remoteEnabled: true
  remoteStreamingV2Enabled: true
```

Remove any `byteplus-gateway` entry from `models.yml`. `pi.registerProvider()` replaces the provider's full model list; two sources create an ambiguous catalog.

## Failure behavior

The extension fails during loading when the local file is missing, invalid, insecure, or incompatible. It rejects:

- unknown fields
- duplicate model IDs
- empty or missing secrets
- non-HTTPS or credential-bearing URLs
- Codex URLs without the exact `/responses?omp_codex_suffix=` form
- arbitrary URL query strings or fragments
- incompatible thinking modes
- `webSearchModel` values that are missing or name a non-Codex model
- literal-key files readable by group or other users

It never logs API-key values.

Remote compaction is bounded to 29 seconds because OMP 17.2.x enforces a 30-second extension-handler deadline. Any credential, transport, protocol, or timeout failure returns `{ cancel: true }`, so OMP aborts compaction instead of invoking its native V2 collector or generating a local LLM summary.

## Verify

```bash
bun install
bun run check
omp models byteplus-gateway --json
```

For a real gateway, start a fresh session with a configured Codex model, send a normal prompt, then run:

```text
/compact remote
```

With `PI_CODEX_DEBUG=1`, the normal turn log must report `transport: "websocket"` and a WSS URL whose path ends in `/responses`. A successful compaction entry must have `fromExtension: true` and `preserveData.openaiRemoteCompaction.version: "v2"`.

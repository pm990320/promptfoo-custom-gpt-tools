# promptfoo-custom-gpt-tools - Architecture

## Design Principles

1. **Delegate to promptfoo** - Use `loadApiProvider('openai:responses:<model>')` to get a fully configured `OpenAiResponsesProvider`. We inherit all auth, retry, caching, body building, response parsing, and cost calculation.
2. **Only add what's missing** - Container lifecycle (create, upload, download) and file assertions. Promptfoo's provider handles everything else.
3. **Support Codex CLI OAuth** - Read tokens from `~/.codex/auth.json` to use ChatGPT subscription quota instead of per-token API billing.

## Architecture

```
src/
  index.ts          # Public exports
  provider.ts       # CodeInterpreterProvider - wraps promptfoo's OpenAiResponsesProvider
  container.ts      # Container lifecycle: create, upload, list, download, cleanup
  codex-auth.ts     # Read/refresh Codex CLI OAuth tokens from ~/.codex/auth.json
  types.ts          # TypeScript interfaces
assertions/
  index.ts          # Assertion helpers export
  xlsx.ts           # Excel file validation (exceljs)
  file.ts           # Generic file assertions
```

## Provider flow

```
callApi(prompt, context)
  |
  +-- ensureInitialized()
  |     +-- resolveCodexAuth() or OPENAI_API_KEY
  |     +-- loadApiProvider('openai:responses:<model>', config)
  |     +-- new ContainerManager(openaiClient)
  |
  +-- containerManager.createOrReuse(knowledgeFiles)
  |     +-- hashKnowledgeFiles() -> check cache -> create if needed
  |     +-- upload knowledge files
  |
  +-- upload input files (per test case)
  +-- snapshot container files (before)
  +-- inject code_interpreter tool with containerId
  +-- baseProvider.callApi(enrichedPrompt)    <-- promptfoo handles everything
  +-- snapshot container files (after)
  +-- download new files (after - before - uploaded)
  +-- return enriched result with file metadata
  +-- cleanup container (per strategy)
```

## Auth modes

### API Key (default)
Standard `OPENAI_API_KEY` env var. Passed to promptfoo's provider as `apiKey` config.

### Codex CLI OAuth
Reads `~/.codex/auth.json`:
```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "eyJ...",
    "refresh_token": "...",
    "id_token": "eyJ...",
    "account_id": "..."
  },
  "last_refresh": "2026-02-28T..."
}
```

- Access token used as bearer token (same header format as API key)
- Auto-refresh via `POST https://auth.openai.com/oauth/token`
- Cached for 7 min (tokens expire in ~8-10 min)
- Uses ChatGPT subscription (Plus/Pro) quota, not per-token billing
- Falls back to `OPENAI_API_KEY` if auth.json has `auth_mode: "api_key"`

## Key decisions

1. **Composition over inheritance** - We don't extend `OpenAiResponsesProvider` directly because it's not part of promptfoo's public API (ERR_PACKAGE_PATH_NOT_EXPORTED). Instead we use `loadApiProvider` to get an instance and delegate to it.
2. **Tool injection via provider config mutation** - We modify the loaded provider's `config.tools` array to inject `{ type: 'code_interpreter', container: containerId }` before each call. This ensures the tool appears in the request body built by `getOpenAiBody()`.
3. **Lazy initialization** - Provider and container manager are created on first `callApi()` because auth resolution and provider loading are async, but `constructor()` must be sync.
4. **Peer dependency on promptfoo** - We `import('promptfoo')` dynamically at runtime. It must be installed by the consumer (who is running promptfoo evals anyway).

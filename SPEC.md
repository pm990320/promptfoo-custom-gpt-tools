# promptfoo-custom-gpt-tools - Architecture

## Design Principles

1. **OpenAI SDK directly** - Uses the `openai` npm package to call the Responses API with Code Interpreter containers.
2. **Only add what's missing** - Container lifecycle (create, upload, download) and file assertions. The OpenAI SDK handles the API calls.
3. **Simple auth** - `OPENAI_API_KEY` env var, nothing else.

## Architecture

```
src/
  index.ts          # Public exports
  provider.ts       # CodeInterpreterProvider - wraps OpenAI Responses API
  container.ts      # Container lifecycle: create, upload, list, download, cleanup (plain fetch)
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
  |     +-- read OPENAI_API_KEY
  |     +-- new OpenAI({ apiKey })
  |     +-- new ContainerManager(apiKey)
  |
  +-- containerManager.createOrReuse(knowledgeFiles)
  |     +-- hashKnowledgeFiles() -> check cache -> create if needed
  |     +-- upload knowledge files via fetch
  |
  +-- upload input files (per test case)
  +-- snapshot container files (before)
  +-- client.responses.create() with code_interpreter tool + containerId
  +-- snapshot container files (after)
  +-- download new files (after - before - uploaded)
  +-- return enriched result with file metadata
  +-- cleanup container (per strategy)
```

## Container API

The OpenAI SDK (v4) doesn't fully expose the Containers file API, so the ContainerManager
uses plain `fetch()` against `https://api.openai.com/v1/containers/` endpoints:

- `POST /containers` - create container
- `POST /containers/{id}/files` - upload file (multipart/form-data)
- `GET /containers/{id}/files` - list files
- `GET /containers/{id}/files/{file_id}/content` - download file
- `DELETE /containers/{id}` - delete container

## Key decisions

1. **Plain fetch for container files** - The SDK's `client.containers.files` object exists but doesn't expose upload/list methods properly. Plain fetch with auth header works.
2. **Lazy initialization** - Provider and container manager are created on first `callApi()` because the constructor must be sync (promptfoo calls `new Provider(config)`).
3. **Export class, not instance** - promptfoo's `file://` loader expects a class it can instantiate with `new Class(options)`. The `.cjs` provider file exports the class.
4. **Container reuse** - Knowledge files are hashed by filename + content. Same hash reuses an existing container to avoid re-uploading static files per test case.

# promptfoo-custom-gpt-tools

Promptfoo provider + assertion helpers for evaluating file-processing GPT workflows powered by OpenAI Code Interpreter.

Built on top of promptfoo's `OpenAiResponsesProvider` via `loadApiProvider` - inherits all auth, retry, caching, body building, response parsing, and cost calculation.

## Features

- ✅ Wraps promptfoo's native OpenAI Responses API provider
- ✅ Container lifecycle: create, upload knowledge/input files, download outputs
- ✅ Container reuse via knowledge file content hashing
- ✅ **Codex CLI OAuth auth** - use your ChatGPT subscription instead of API tokens
- ✅ Assertion helpers: `xlsxAssert()`, `fileAssert()`
- ✅ TypeScript + dual ESM/CJS output

## Installation

```bash
npm install promptfoo-custom-gpt-tools
```

Requirements: `promptfoo >= 0.100.0` (peer), Node.js `>=18`

## Authentication

### API Key (default)

```bash
export OPENAI_API_KEY="sk-..."
```

### Codex CLI OAuth (use your ChatGPT subscription)

```bash
# First, authenticate with Codex CLI
codex login

# Then configure the provider with auth: 'codex'
```

When using `auth: 'codex'`, the provider reads OAuth tokens from `~/.codex/auth.json` (written by `codex login`). This uses your ChatGPT Plus/Pro subscription quota instead of per-token API billing. Tokens are automatically refreshed when expired.

## Quick start

### 1) Create a provider module

`provider.js`:

```js
const { CodeInterpreterProvider } = require('promptfoo-custom-gpt-tools');

module.exports = new CodeInterpreterProvider({
  model: 'gpt-5.2',
  instructions: 'file://./system_prompt.md',
  knowledge_files: ['./knowledge/helper.py'],
  input_files: ['{{input_file}}'],
  container: {
    memory_limit: '4g',
    cleanup: 'on-success',
    reuse_by_knowledge_hash: true,
  },
  output_dir: './eval_output',
  timeout_ms: 120000,

  // Optional: use Codex CLI OAuth instead of API key
  // auth: 'codex',

  // Optional: pass-through config to the underlying OpenAI provider
  // provider_config: {
  //   reasoning: { effort: 'high' },
  //   temperature: 0,
  // },
});
```

### 2) Reference in `promptfooconfig.yaml`

```yaml
description: File processing eval
providers:
  - id: file://./provider.js

prompts:
  - "{{user_prompt}}"

tests:
  - vars:
      user_prompt: "Process the uploaded file and generate the output"
      input_file: ./test_data/input.xlsx
```

Run:

```bash
npx promptfoo eval
```

## Provider config

```ts
interface CodeInterpreterProviderConfig {
  model: string;                  // OpenAI model name
  instructions?: string;         // System prompt (literal or file://path)
  knowledge_files?: string[];    // Pre-loaded into container (like GPT Knowledge)
  input_files?: string[];        // Per-test files (supports {{vars}})
  output_dir?: string;           // Where to save downloaded output files
  timeout_ms?: number;           // Default: 120000
  config_dir?: string;           // Base directory for relative paths
  auth?: 'api-key' | 'codex';   // Auth mode (default: 'api-key')
  codex_home?: string;           // Codex home dir (default: ~/.codex)
  container?: {
    memory_limit?: '1g' | '4g' | '16g' | '64g';
    cleanup?: 'always' | 'on-success' | 'never';
    reuse_by_knowledge_hash?: boolean;  // Default: true
  };
  provider_config?: {            // Pass-through to promptfoo's OpenAI provider
    reasoning?: { effort: string };
    temperature?: number;
    top_p?: number;
    max_output_tokens?: number;
    response_format?: object;
    // ... any OpenAiCompletionOptions
  };
}
```

## How it works

1. On first `callApi()`, loads promptfoo's `OpenAiResponsesProvider` via `loadApiProvider('openai:responses:<model>')`
2. Creates (or reuses) a Code Interpreter container
3. Uploads knowledge files + per-test input files to the container
4. Injects `{ type: 'code_interpreter', container: containerId }` tool
5. Delegates the API call to promptfoo's provider (inherits retry, caching, parsing, cost)
6. Downloads newly created files from the container
7. Returns enriched result with `metadata.outputFiles`, `metadata.containerFiles`, etc.

## Assertion helpers

```js
const { xlsxAssert, fileAssert } = require('promptfoo-custom-gpt-tools/assertions');
```

### `xlsxAssert(filePath, options)`

```yaml
assert:
  - type: javascript
    value: |
      const { xlsxAssert } = require('promptfoo-custom-gpt-tools/assertions');
      const output = context.providerResponse.metadata.outputFiles[0];
      return xlsxAssert(output, {
        minSheets: 3,
        requiredSheets: ['Sheet1', 'Summary'],
        columnExists: { sheet: 'Sheet1', row: 1, value: 'Total' },
        noErrors: true,
        noEmptyCells: {
          sheet: 'Sheet1',
          startRow: 2,
          endRow: 50,
          column: 5,
        },
        preservedData: {
          referenceFile: context.vars.input_file,
          sheet: 'Sheet1',
          range: { startRow: 2, endRow: 50, startCol: 1, endCol: 4 },
        },
      });
```

### `fileAssert(filePath, options)`

```yaml
assert:
  - type: javascript
    value: |
      const { fileAssert } = require('promptfoo-custom-gpt-tools/assertions');
      return fileAssert(context.providerResponse.metadata.outputFiles[0], {
        exists: true,
        minSize: 1024,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
```

## Container reuse

Knowledge files are hashed (sha256) by filename + content. Same hash reuses an existing container; different hash creates a new one. This avoids re-uploading large static files for every test case.

## Example

See [`example/`](./example/) for a complete working eval project (student gradebook processor)
with test data, knowledge files, system prompt, assertions, and promptfoo config.

```bash
# Quick run
npm install
export OPENAI_API_KEY="sk-..."
npx promptfoo eval -c example/promptfooconfig.yaml
```

## Development

```bash
npm install
npm run check    # typecheck + lint
npm run build
```

## License

MIT

## Limitations

### Codex OAuth Scope

The Codex CLI OAuth tokens are generated for the Codex service, not for direct API access. They may lack the `api.responses.write` scope required for the Responses API. 

If you get a 401 "Missing scopes" error when using `auth: 'codex'`, you'll need to:
1. Use a standard API key (`auth: 'api-key'`, set `OPENAI_API_KEY`)
2. Or generate OAuth tokens with API permissions (different OAuth client setup)

The Codex OAuth path works for authentication but may fail at the API call stage depending on your organization's API permissions.

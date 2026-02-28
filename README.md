# promptfoo-custom-gpt-tools

Promptfoo provider + assertion helpers for evaluating file-processing GPT workflows powered by OpenAI Code Interpreter.

Uses the OpenAI Responses API with Code Interpreter containers for file upload, execution, and output download.

## Features

- OpenAI Responses API with Code Interpreter tool
- Container lifecycle: create, upload knowledge/input files, download outputs
- Container reuse via knowledge file content hashing
- Assertion helpers: `xlsxAssert()`, `fileAssert()`
- TypeScript + dual ESM/CJS output

## Installation

```bash
npm install promptfoo-custom-gpt-tools
```

Requirements: `promptfoo >= 0.100.0` (peer), Node.js `>=18`

## Authentication

```bash
export OPENAI_API_KEY="sk-..."
```

## Quick start

### 1) Create a provider module

`provider.cjs`:

```js
const { CodeInterpreterProvider } = require('promptfoo-custom-gpt-tools');
module.exports = CodeInterpreterProvider;
```

### 2) Reference in `promptfooconfig.yaml`

```yaml
description: File processing eval

providers:
  - id: file://./provider.cjs
    config:
      model: gpt-5.2
      instructions: file://./system_prompt.md
      knowledge_files:
        - ./knowledge/helper.py
      input_files:
        - "{{input_file}}"
      container:
        memory_limit: 4g
        cleanup: on-success
        reuse_by_knowledge_hash: true
      output_dir: ./eval_output
      timeout_ms: 120000

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
  container?: {
    memory_limit?: '1g' | '4g' | '16g' | '64g';
    cleanup?: 'always' | 'on-success' | 'never';
    reuse_by_knowledge_hash?: boolean;  // Default: true
  };
}
```

## How it works

1. On first `callApi()`, creates an OpenAI client from `OPENAI_API_KEY`
2. Creates (or reuses) a Code Interpreter container
3. Uploads knowledge files + per-test input files to the container
4. Calls the Responses API with `code_interpreter` tool bound to the container
5. Downloads newly created files from the container
6. Returns result with `metadata.outputFiles`, `metadata.containerFiles`, etc.

## Assertion helpers

```js
const { xlsxAssert, fileAssert } = require('promptfoo-custom-gpt-tools/assertions');
```

### `xlsxAssert(filePath, options)`

```yaml
assert:
  - type: javascript
    value: "file://./assert_xlsx.cjs"
```

```js
// assert_xlsx.cjs
module.exports = (output, context) => {
  const { xlsxAssert } = require('promptfoo-custom-gpt-tools/assertions');
  const files = context.providerResponse?.metadata?.outputFiles ?? [];
  const xlsx = files.find(f => f.endsWith('.xlsx'));
  if (!xlsx) return false;
  return xlsxAssert(xlsx, { minSheets: 2, noErrors: true }).then(r => r.pass);
};
```

Options: `minSheets`, `requiredSheets`, `columnExists`, `noErrors`, `noEmptyCells`, `preservedData`.

### `fileAssert(filePath, options)`

Options: `exists`, `minSize`, `mimeType`.

## Container reuse

Knowledge files are hashed (sha256) by filename + content. Same hash reuses an existing container; different hash creates a new one. This avoids re-uploading large static files for every test case.

## Example

See [`example/`](./example/) for a complete working eval project (student gradebook processor).

```bash
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

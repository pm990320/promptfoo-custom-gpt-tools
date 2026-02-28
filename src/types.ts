export type CleanupStrategy = 'always' | 'on-success' | 'never';

export interface ContainerConfig {
  memory_limit?: '1g' | '4g' | '16g' | '64g';
  cleanup?: CleanupStrategy;
  reuse_by_knowledge_hash?: boolean;
}

export interface CodeInterpreterProviderConfig {
  /** OpenAI model name (e.g. 'gpt-5.2') */
  model: string;

  /** System prompt - literal string or file://path */
  instructions?: string;

  /** Files pre-loaded into the container (like GPT Knowledge files) */
  knowledge_files?: string[];

  /** Per-test-case files uploaded to the container (supports {{vars}}) */
  input_files?: string[];

  /** Local directory for downloaded generated files */
  output_dir?: string;

  /** Max wait time for a response (ms) */
  timeout_ms?: number;

  /** Base directory for resolving relative file paths */
  config_dir?: string;

  /** Container lifecycle settings */
  container?: ContainerConfig;

  /**
   * Additional promptfoo OpenAI provider config options.
   * These are passed through to the underlying OpenAiResponsesProvider.
   * Supports: reasoning, reasoning_effort, temperature, top_p,
   * max_output_tokens, response_format, passthrough, headers, etc.
   */
  provider_config?: Record<string, unknown>;
}

export interface UploadedContainerFile {
  id: string;
  filename: string;
  localPath?: string;
}

export interface ContainerFileEntry {
  id: string;
  filename: string;
}

export interface XlsxColumnExistsCheck {
  sheet: string;
  row: number;
  value: string;
}

export interface XlsxNoEmptyCellsCheck {
  sheet: string;
  startRow: number;
  endRow: number;
  column: number;
}

export interface XlsxPreservedDataCheck {
  referenceFile: string;
  sheet: string;
  range: {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
  };
}

export interface XlsxAssertOptions {
  minSheets?: number;
  maxSheets?: number;
  requiredSheets?: string[];
  columnExists?: XlsxColumnExistsCheck;
  noErrors?: boolean;
  noEmptyCells?: XlsxNoEmptyCellsCheck;
  preservedData?: XlsxPreservedDataCheck;
}

export interface FileAssertOptions {
  exists?: boolean;
  minSize?: number;
  maxSize?: number;
  mimeType?: string | string[];
  extension?: string | string[];
}

export interface AssertionResult {
  pass: boolean;
  score?: number;
  reason?: string;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { ContainerManager } from './container.js';
import { resolveCodexAuth } from './codex-auth.js';
import type {
  CodeInterpreterProviderConfig,
  ContainerFileEntry,
  UploadedContainerFile,
} from './types.js';

/**
 * Promptfoo provider/response types.
 * We use the shapes from promptfoo's public API rather than importing
 * internal classes, so we stay compatible across promptfoo versions.
 */
interface ProviderResponse {
  output?: string;
  error?: string;
  tokenUsage?: { total?: number; prompt?: number; completion?: number };
  cost?: number;
  metadata?: Record<string, unknown>;
}

interface ApiProvider {
  id(): string;
  callApi(
    prompt: string,
    context?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<ProviderResponse>;
}

interface CallContext {
  vars?: Record<string, unknown>;
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'gpt-5.2';

function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });
}

/**
 * Promptfoo custom provider that wraps OpenAiResponsesProvider with
 * container lifecycle management for Code Interpreter file-processing evals.
 *
 * Uses promptfoo's `loadApiProvider` (stable public API) to create the
 * underlying responses provider, so we inherit all auth handling, body
 * building, caching, error handling, cost calculation, etc.
 */
export class CodeInterpreterProvider implements ApiProvider {
  private readonly config: CodeInterpreterProviderConfig;
  private baseProvider: ApiProvider | undefined;
  private containerManager: ContainerManager | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(config: CodeInterpreterProviderConfig) {
    this.config = {
      ...config,
      model: config.model || DEFAULT_MODEL,
      timeout_ms: config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      output_dir: config.output_dir ?? './eval_output',
      container: config.container ?? {},
    };
  }

  id(): string {
    return `promptfoo-custom-gpt-tools:${this.config.model}`;
  }

  /**
   * Lazy-initialize the underlying promptfoo provider and container manager.
   * We do this lazily because resolveCodexAuth is async and loadApiProvider
   * returns a promise.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.baseProvider) return;

    this.initPromise ??= this.initialize();

    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    // Resolve auth
    let apiKey: string | undefined;

    if (this.config.auth === 'codex') {
      apiKey = await resolveCodexAuth(this.config.codex_home);
    } else {
      apiKey = process.env.OPENAI_API_KEY;
    }

    if (!apiKey) {
      throw new Error(
        'No API key available. Set OPENAI_API_KEY or use auth: "codex" with "codex login".',
      );
    }

    // Load instructions if file:// reference
    let instructions = this.config.instructions;
    if (instructions?.startsWith('file://')) {
      const filePath = instructions.slice('file://'.length);
      const absolute = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(this.resolveBaseDir(), filePath);
      instructions = await fs.readFile(absolute, 'utf8');
    }

    // Build promptfoo provider config
    const providerConfig: Record<string, unknown> = {
      apiKey,
      ...(instructions ? { instructions } : {}),
      ...(this.config.provider_config ?? {}),
    };

    // Use promptfoo's public loadApiProvider to get a properly configured
    // OpenAiResponsesProvider. This handles all auth, retry, caching, body
    // building, response parsing, and cost calculation.
    const { loadApiProvider } = await import('promptfoo');
    this.baseProvider = (await loadApiProvider(
      `openai:responses:${this.config.model}`,
      { options: { config: providerConfig } },
    )) as ApiProvider;

    // Initialize container manager with the same API key
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey });
    this.containerManager = new ContainerManager(client);
  }

  async callApi(
    prompt: string,
    context?: CallContext,
    options?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    await this.ensureInitialized();

    const containerMgr = this.containerManager;
    const baseProvider = this.baseProvider;
    if (!containerMgr || !baseProvider) {
      throw new Error('Provider not initialized');
    }
    const cleanupStrategy = this.config.container?.cleanup ?? 'on-success';
    const allowReuse = this.config.container?.reuse_by_knowledge_hash ?? true;

    let containerId = '';
    let knowledgeHash = '';

    try {
      const vars = (context?.vars ?? {});
      const baseDir = this.resolveBaseDir();

      // Resolve file paths
      const knowledgeFiles = await this.resolveFiles(
        this.config.knowledge_files ?? [],
        vars,
        baseDir,
      );
      const inputFiles = await this.resolveFiles(
        this.config.input_files ?? [],
        vars,
        baseDir,
      );

      // Create or reuse container, upload knowledge files
      const container = await containerMgr.createOrReuse({
        knowledgeFiles,
        memoryLimit: this.config.container?.memory_limit,
        allowReuse,
      });

      containerId = container.containerId;
      knowledgeHash = container.knowledgeHash;

      // Upload per-test input files
      const uploadedInputFiles: UploadedContainerFile[] = [];
      for (const filePath of inputFiles) {
        uploadedInputFiles.push(
          await containerMgr.uploadFileToContainer(containerId, filePath),
        );
      }

      // Snapshot container state before the run
      const beforeFiles = await containerMgr.listContainerFiles(containerId);
      const uploadedIds = new Set<string>([
        ...container.uploadedKnowledgeFileIds,
        ...uploadedInputFiles.map((f) => f.id),
      ]);

      // Build the enriched prompt with file references
      const messageLines = [prompt.trim()];
      if (uploadedInputFiles.length > 0) {
        messageLines.push('');
        messageLines.push('Input files available in the container:');
        for (const file of uploadedInputFiles) {
          messageLines.push(`- ${file.filename}`);
        }
      }
      const enrichedPrompt = messageLines.join('\n').trim();

      // Inject code_interpreter tool with our container into the provider.
      // We modify the provider's config to include the tool, which getOpenAiBody()
      // will pick up when building the request body.
      const providerRecord = baseProvider as unknown as {
        config?: Record<string, unknown>;
      };
      if (providerRecord.config) {
        const rawTools = providerRecord.config.tools;
        const existingTools: unknown[] = Array.isArray(rawTools) ? rawTools : [];
        providerRecord.config.tools = [
          ...existingTools.filter(
            (t) =>
              !(t && typeof t === 'object' && (t as Record<string, unknown>).type === 'code_interpreter'),
          ),
          { type: 'code_interpreter', container: containerId },
        ];
      }

      // Delegate the actual API call to promptfoo's provider
      const result = await baseProvider.callApi(enrichedPrompt, context, options);

      // Download newly created files from the container
      const afterFiles = await containerMgr.listContainerFiles(containerId);
      const outputFiles = await this.downloadNewFiles({
        containerMgr,
        containerId,
        beforeFiles,
        afterFiles,
        uploadedIds,
      });

      // Enrich the result with file metadata
      const enrichedResult: ProviderResponse = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          outputFiles,
          containerFiles: afterFiles.map((f) => f.filename),
          containerId,
        },
      };

      // Cleanup
      if (cleanupStrategy === 'always' || cleanupStrategy === 'on-success') {
        await containerMgr.cleanupContainer(containerId, knowledgeHash);
      }

      return enrichedResult;
    } catch (error) {
      if (containerId && cleanupStrategy === 'always') {
        await containerMgr.cleanupContainer(containerId, knowledgeHash);
      }
      return {
        error: error instanceof Error ? error.message : String(error),
        metadata: { containerId: containerId || undefined },
      };
    }
  }

  private async downloadNewFiles(params: {
    containerMgr: ContainerManager;
    containerId: string;
    beforeFiles: ContainerFileEntry[];
    afterFiles: ContainerFileEntry[];
    uploadedIds: Set<string>;
  }): Promise<string[]> {
    const beforeIds = new Set(params.beforeFiles.map((f) => f.id));
    const outputPaths: string[] = [];
    const outputDir = path.resolve(
      this.resolveBaseDir(),
      this.config.output_dir ?? './eval_output',
    );

    for (const file of params.afterFiles) {
      if (beforeIds.has(file.id)) continue;
      if (params.uploadedIds.has(file.id)) continue;

      const destination = params.containerMgr.makeOutputPath(outputDir, file.filename);
      await params.containerMgr.downloadFileToPath(
        params.containerId,
        file.id,
        destination,
      );
      outputPaths.push(destination);
    }

    return outputPaths;
  }

  private resolveBaseDir(): string {
    if (this.config.config_dir) return path.resolve(this.config.config_dir);
    return process.cwd();
  }

  private async resolveFiles(
    entries: string[],
    vars: Record<string, unknown>,
    baseDir: string,
  ): Promise<string[]> {
    const results: string[] = [];

    for (const entry of entries) {
      const rendered = renderTemplate(entry, vars);
      const absolute = path.isAbsolute(rendered)
        ? rendered
        : path.resolve(baseDir, rendered);
      await fs.access(absolute);
      results.push(absolute);
    }

    return results;
  }
}

// Re-export for convenience
export { hashKnowledgeFiles } from './container.js';

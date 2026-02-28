import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { ContainerManager } from './container.js';
import { resolveCodexAuth } from './codex-auth.js';
import type {
  CodeInterpreterProviderConfig,
  ContainerFileEntry,
  UploadedContainerFile,
} from './types.js';

interface ProviderResponse {
  output?: string;
  error?: string;
  tokenUsage?: { total?: number; prompt?: number; completion?: number };
  cost?: number;
  metadata?: Record<string, unknown>;
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
 * Promptfoo provider that wraps OpenAI Responses API with Code Interpreter.
 * This version uses the OpenAI SDK directly to avoid recursive loading issues
 * with promptfoo's loadApiProvider.
 */
export class CodeInterpreterProvider {
  private readonly config: CodeInterpreterProviderConfig;
  private client: OpenAI | undefined;
  private containerManager: ContainerManager | undefined;

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
   * Lazy-initialize the OpenAI client and container manager.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.client && this.containerManager) return;

    // Resolve auth
    let apiKey: string;

    if (this.config.auth === 'codex') {
      apiKey = await resolveCodexAuth(this.config.codex_home);
    } else {
      apiKey = process.env['OPENAI_API_KEY'] ?? '';
    }

    if (!apiKey) {
      throw new Error(
        'No API key. Set OPENAI_API_KEY or use auth: "codex" with "codex login".',
      );
    }

    this.client = new OpenAI({ apiKey });
    this.containerManager = new ContainerManager(this.client);
  }

  async callApi(
    prompt: string,
    context?: CallContext,
    _options?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    await this.ensureInitialized();

    const containerMgr = this.containerManager!;
    const client = this.client!;

    if (!containerMgr || !client) {
      throw new Error('Provider not initialized');
    }

    const cleanupStrategy = this.config.container?.cleanup ?? 'on-success';
    const allowReuse = this.config.container?.reuse_by_knowledge_hash ?? true;

    let containerId = '';
    let knowledgeHash = '';

    try {
      const vars = (context?.vars ?? {}) as Record<string, unknown>;
      const baseDir = this.resolveBaseDir();

      // Resolve instructions
      let instructions = this.config.instructions;
      if (instructions?.startsWith('file://')) {
        const filePath = instructions.slice('file://'.length);
        const absolute = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(baseDir, filePath);
        instructions = await fs.readFile(absolute, 'utf8');
      }

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

      // Build the prompt with file references
      const messageLines = [prompt.trim()];
      if (uploadedInputFiles.length > 0) {
        messageLines.push('');
        messageLines.push('Input files available in the container:');
        for (const file of uploadedInputFiles) {
          messageLines.push(`- ${file.filename}`);
        }
      }
      const enrichedPrompt = messageLines.join('\n').trim();

      // Call the Responses API with code_interpreter tool
      const response = await this.callResponsesApi(
        client,
        containerId,
        instructions,
        enrichedPrompt,
      );

      // Download newly created files from the container
      const afterFiles = await containerMgr.listContainerFiles(containerId);
      const outputFiles = await this.downloadNewFiles({
        containerMgr,
        containerId,
        beforeFiles,
        afterFiles,
        uploadedIds,
      });

      // Build the result
      const result: ProviderResponse = {
        output: response.outputText,
        tokenUsage: response.usage,
        cost: response.cost,
        metadata: {
          outputFiles,
          containerFiles: afterFiles.map((f) => f.filename),
          containerId,
        },
      };

      // Cleanup
      if (cleanupStrategy === 'always' || cleanupStrategy === 'on-success') {
        await containerMgr.cleanupContainer(containerId, knowledgeHash);
      }

      return result;
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

  private async callResponsesApi(
    client: OpenAI,
    containerId: string,
    instructions: string | undefined,
    prompt: string,
  ): Promise<{
    outputText: string;
    usage?: { total?: number; prompt?: number; completion?: number };
    cost?: number;
  }> {
    // Build the request similar to promptfoo's OpenAiResponsesProvider
    const tools = [{ type: 'code_interpreter' as const, container: containerId }];

    const response = await client.responses.create({
      model: this.config.model,
      ...(instructions ? { instructions } : {}),
      input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: prompt }] }],
      tools,
      text: { format: { type: 'text' as const } },
    });

    // Extract output text
    let outputText = '';
    if (response.output_text) {
      outputText = response.output_text;
    } else if (response.output) {
      const chunks: string[] = [];
      for (const item of response.output) {
        if ('content' in item && Array.isArray(item.content)) {
          for (const block of item.content) {
            if ('text' in block && typeof block.text === 'string') {
              chunks.push(block.text);
            }
          }
        }
      }
      outputText = chunks.join('\n').trim();
    }

    // Extract usage
    const usage = response.usage
      ? {
          total: response.usage.total_tokens,
          prompt: response.usage.input_tokens,
          completion: response.usage.output_tokens,
        }
      : undefined;

    // Note: cost calculation would require pricing data - omitting for simplicity

    return { outputText, usage, cost: undefined };
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

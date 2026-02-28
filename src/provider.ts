import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { ContainerManager } from './container.js';
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

  private ensureInitialized(): void {
    if (this.client && this.containerManager) return;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    this.client = new OpenAI({ apiKey });
    this.containerManager = new ContainerManager(apiKey);
  }

  async callApi(
    prompt: string,
    context?: CallContext,
    _options?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    this.ensureInitialized();

    const containerMgr = this.containerManager;
    const client = this.client;
    if (!containerMgr || !client) throw new Error('Provider not initialized');

    const cleanupStrategy = this.config.container?.cleanup ?? 'on-success';
    const allowReuse = this.config.container?.reuse_by_knowledge_hash ?? true;
    let containerId = '';
    let knowledgeHash = '';

    try {
      const vars = context?.vars ?? {};
      const baseDir = this.resolveBaseDir();

      // Resolve instructions
      let instructions = this.config.instructions;
      if (instructions?.startsWith('file://')) {
        const filePath = instructions.slice('file://'.length);
        const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
        instructions = await fs.readFile(absolute, 'utf8');
      }

      // Resolve file paths
      const knowledgeFiles = await this.resolveFiles(this.config.knowledge_files ?? [], vars, baseDir);
      const inputFiles = await this.resolveFiles(this.config.input_files ?? [], vars, baseDir);

      // Create or reuse container + upload knowledge files
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
        uploadedInputFiles.push(await containerMgr.uploadFile(containerId, filePath));
      }

      // Snapshot before
      const beforeFiles = await containerMgr.listFiles(containerId);
      const uploadedIds = new Set<string>([
        ...container.uploadedKnowledgeFileIds,
        ...uploadedInputFiles.map((f) => f.id),
      ]);

      // Build prompt
      const messageLines = [prompt.trim()];
      if (uploadedInputFiles.length > 0) {
        messageLines.push('', 'Input files available in the container:');
        for (const file of uploadedInputFiles) messageLines.push(`- ${file.filename}`);
      }

      // Call Responses API
      const response = await client.responses.create({
        model: this.config.model,
        ...(instructions ? { instructions } : {}),
        input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: messageLines.join('\n').trim() }] }],
        tools: [{ type: 'code_interpreter' as const, container: containerId }],
        text: { format: { type: 'text' as const } },
      });

      // Extract output
      let outputText = response.output_text;
      if (!outputText && response.output.length > 0) {
        const chunks: string[] = [];
        for (const item of response.output) {
          if ('content' in item && Array.isArray(item.content)) {
            for (const block of item.content) {
              if ('text' in block && typeof block.text === 'string') chunks.push(block.text);
            }
          }
        }
        outputText = chunks.join('\n').trim();
      }

      // Download new files
      const afterFiles = await containerMgr.listFiles(containerId);
      const outputFiles = await this.downloadNewFiles({ containerMgr, containerId, beforeFiles, afterFiles, uploadedIds });

      const result: ProviderResponse = {
        output: outputText,
        tokenUsage: response.usage ? {
          total: response.usage.total_tokens,
          prompt: response.usage.input_tokens,
          completion: response.usage.output_tokens,
        } : undefined,
        metadata: {
          outputFiles,
          containerFiles: afterFiles.map((f) => f.filename),
          containerId,
        },
      };

      if (cleanupStrategy === 'always' || cleanupStrategy === 'on-success') {
        await containerMgr.deleteContainer(containerId, knowledgeHash);
      }
      return result;
    } catch (error) {
      if (containerId && cleanupStrategy === 'always') {
        await containerMgr.deleteContainer(containerId, knowledgeHash);
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
    const outputDir = path.resolve(this.resolveBaseDir(), this.config.output_dir ?? './eval_output');

    for (const file of params.afterFiles) {
      if (beforeIds.has(file.id) || params.uploadedIds.has(file.id)) continue;
      const dest = params.containerMgr.makeOutputPath(outputDir, file.filename);
      await params.containerMgr.downloadFile(params.containerId, file.id, dest);
      outputPaths.push(dest);
    }
    return outputPaths;
  }

  private resolveBaseDir(): string {
    return this.config.config_dir ? path.resolve(this.config.config_dir) : process.cwd();
  }

  private async resolveFiles(entries: string[], vars: Record<string, unknown>, baseDir: string): Promise<string[]> {
    const results: string[] = [];
    for (const entry of entries) {
      const rendered = renderTemplate(entry, vars);
      const absolute = path.isAbsolute(rendered) ? rendered : path.resolve(baseDir, rendered);
      await fs.access(absolute);
      results.push(absolute);
    }
    return results;
  }
}

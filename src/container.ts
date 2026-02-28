import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type OpenAI from 'openai';
import type { ContainerFileEntry, UploadedContainerFile } from './types';

interface CachedContainer {
  containerId: string;
  knowledgeHash: string;
}

interface CreateOrReuseParams {
  knowledgeFiles: string[];
  memoryLimit?: '1g' | '4g' | '16g' | '64g';
  allowReuse: boolean;
}

interface CreateOrReuseResult {
  containerId: string;
  knowledgeHash: string;
  reused: boolean;
  uploadedKnowledgeFileIds: Set<string>;
}

const containerCache = new Map<string, CachedContainer>();

function toFilename(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const direct = record.filename ?? record.name ?? record.path;
    if (typeof direct === 'string') return direct;
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- deliberately stringifying unknown API values
  return String(input);
}

function getId(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const id = record.id ?? record.file_id;
  return typeof id === 'string' ? id : '';
}

async function hashFile(filePath: string): Promise<string> {
  const data = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function hashKnowledgeFiles(files: string[]): Promise<string> {
  if (files.length === 0) return 'no-knowledge-files';
  const entries = await Promise.all(
    files.map(async (filePath) => {
      const digest = await hashFile(filePath);
      return `${path.basename(filePath)}:${digest}`;
    }),
  );
  entries.sort();
  return crypto.createHash('sha256').update(entries.join('|')).digest('hex');
}

export class ContainerManager {
  constructor(private readonly client: OpenAI) {}

  async createOrReuse(params: CreateOrReuseParams): Promise<CreateOrReuseResult> {
    const knowledgeHash = await hashKnowledgeFiles(params.knowledgeFiles);

    if (params.allowReuse) {
      const cached = containerCache.get(knowledgeHash);
      if (cached) {
        return {
          containerId: cached.containerId,
          knowledgeHash,
          reused: true,
          uploadedKnowledgeFileIds: new Set<string>(),
        };
      }
    }

    const containerId = await this.createContainer(params.memoryLimit);
    const uploadedKnowledgeFileIds = new Set<string>();

    for (const filePath of params.knowledgeFiles) {
      const uploaded = await this.uploadFileToContainer(containerId, filePath);
      uploadedKnowledgeFileIds.add(uploaded.id);
    }

    containerCache.set(knowledgeHash, { containerId, knowledgeHash });

    return {
      containerId,
      knowledgeHash,
      reused: false,
      uploadedKnowledgeFileIds,
    };
  }

  async createContainer(memoryLimit?: '1g' | '4g' | '16g' | '64g'): Promise<string> {
    const api = this.client as unknown as {
      containers?: {
        create?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
    };

    if (!api.containers?.create) {
      throw new Error('OpenAI SDK does not expose client.containers.create(). Please upgrade openai package.');
    }

    const payload: Record<string, unknown> = {
      name: 'promptfoo-custom-gpt-tools',
    };

    if (memoryLimit) payload.memory_limit = memoryLimit;

    const created = await api.containers.create(payload);
    const containerId = getId(created) || (created.id as string | undefined);

    if (!containerId) {
      throw new Error(`Container creation returned no id: ${JSON.stringify(created)}`);
    }

    return containerId;
  }

  async uploadFileToContainer(containerId: string, filePath: string): Promise<UploadedContainerFile> {
    const fileApi = this.client.files as unknown as {
      create: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const uploadedFile = await fileApi.create({
      file: fs.createReadStream(filePath),
      purpose: 'assistants',
    });

    const fileId = getId(uploadedFile) || (uploadedFile.id as string | undefined);
    if (!fileId) {
      throw new Error(`File upload returned no id for ${filePath}`);
    }

    await this.attachFileToContainer(containerId, fileId);

    return {
      id: fileId,
      filename: path.basename(filePath),
      localPath: filePath,
    };
  }

  async attachFileToContainer(containerId: string, fileId: string): Promise<void> {
    const api = this.client as unknown as {
      containers?: {
        files?: {
          create?: (...args: unknown[]) => Promise<unknown>;
        };
      };
    };

    const create = api.containers?.files?.create;
    if (!create) return;

    try {
      await create(containerId, { file_id: fileId });
      return;
    } catch {
      // fallback for alternate signature
    }

    await create({ container_id: containerId, file_id: fileId });
  }

  async listContainerFiles(containerId: string): Promise<ContainerFileEntry[]> {
    const api = this.client as unknown as {
      containers?: {
        files?: {
          list?: (...args: unknown[]) => Promise<Record<string, unknown>>;
        };
      };
    };

    const list = api.containers?.files?.list;
    if (!list) return [];

    let result: Record<string, unknown>;
    try {
      result = await list(containerId);
    } catch {
      result = await list({ container_id: containerId });
    }

    const rawData = result.data;
    const data: unknown[] = Array.isArray(rawData) ? rawData : [];

    return data
      .map((entry) => {
        const id = getId(entry);
        const filename = toFilename(entry);
        if (!id) return null;
        return {
          id,
          filename: filename || id,
        } satisfies ContainerFileEntry;
      })
      .filter((entry): entry is ContainerFileEntry => Boolean(entry));
  }

  async downloadFileToPath(containerId: string, fileId: string, destinationPath: string): Promise<void> {
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });

    const containerApi = this.client as unknown as {
      containers?: {
        files?: {
          content?: (...args: unknown[]) => Promise<unknown>;
        };
      };
    };

    const content = containerApi.containers?.files?.content;

    let response: unknown;
    if (content) {
      try {
        response = await content(containerId, fileId);
      } catch {
        response = await content({ container_id: containerId, file_id: fileId });
      }
    } else {
      const filesApi = this.client.files as unknown as {
        content?: (id: string) => Promise<unknown>;
      };
      if (!filesApi.content) {
        throw new Error('OpenAI SDK does not expose file content download API.');
      }
      response = await filesApi.content(fileId);
    }

    const buffer = await this.toBuffer(response);
    await fsp.writeFile(destinationPath, buffer);
  }

  async toBuffer(response: unknown): Promise<Buffer> {
    if (Buffer.isBuffer(response)) return response;
    if (typeof response === 'string') return Buffer.from(response, 'utf8');
    if (response && typeof response === 'object') {
      const maybeArrayBuffer = response as {
        arrayBuffer?: () => Promise<ArrayBuffer>;
        text?: () => Promise<string>;
      };
      if (typeof maybeArrayBuffer.arrayBuffer === 'function') {
        const arr = await maybeArrayBuffer.arrayBuffer();
        return Buffer.from(arr);
      }
      if (typeof maybeArrayBuffer.text === 'function') {
        const text = await maybeArrayBuffer.text();
        return Buffer.from(text, 'utf8');
      }
    }
    throw new Error('Unable to convert API response to Buffer');
  }

  async cleanupContainer(containerId: string, knowledgeHash?: string): Promise<void> {
    const api = this.client as unknown as {
      containers?: {
        delete?: (...args: unknown[]) => Promise<unknown>;
      };
    };

    if (knowledgeHash) {
      const cached = containerCache.get(knowledgeHash);
      if (cached?.containerId === containerId) {
        containerCache.delete(knowledgeHash);
      }
    }

    const remove = api.containers?.delete;
    if (!remove) return;

    try {
      await remove(containerId);
    } catch {
      await remove({ container_id: containerId });
    }
  }

  makeOutputPath(baseOutputDir: string, fileName: string): string {
    const runDir = path.join(baseOutputDir, new Date().toISOString().replace(/[:.]/g, '-'));
    return path.join(runDir, path.basename(fileName));
  }
}

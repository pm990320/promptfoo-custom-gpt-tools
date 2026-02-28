import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ContainerFileEntry, UploadedContainerFile } from './types.js';

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
const BASE_URL = 'https://api.openai.com/v1';

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

async function apiJson<T>(apiKey: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export class ContainerManager {
  constructor(private readonly apiKey: string) {}

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
      const uploaded = await this.uploadFile(containerId, filePath);
      uploadedKnowledgeFileIds.add(uploaded.id);
    }

    containerCache.set(knowledgeHash, { containerId, knowledgeHash });

    return { containerId, knowledgeHash, reused: false, uploadedKnowledgeFileIds };
  }

  async createContainer(memoryLimit?: '1g' | '4g' | '16g' | '64g'): Promise<string> {
    const body: Record<string, unknown> = { name: 'promptfoo-eval' };
    if (memoryLimit) body.memory_limit = memoryLimit;

    const result = await apiJson<{ id: string }>(
      this.apiKey,
      `${BASE_URL}/containers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    return result.id;
  }

  async uploadFile(containerId: string, filePath: string): Promise<UploadedContainerFile> {
    const fileData = await fsp.readFile(filePath);
    const filename = path.basename(filePath);

    const form = new FormData();
    form.append('file', new Blob([fileData]), filename);

    const result = await apiJson<{ id: string; path: string }>(
      this.apiKey,
      `${BASE_URL}/containers/${containerId}/files`,
      { method: 'POST', body: form },
    );

    return { id: result.id, filename, localPath: filePath };
  }

  async listFiles(containerId: string): Promise<ContainerFileEntry[]> {
    const result = await apiJson<{ data: { id: string; path: string }[] }>(
      this.apiKey,
      `${BASE_URL}/containers/${containerId}/files`,
    );

    return result.data.map((f) => ({
      id: f.id,
      filename: path.basename(f.path),
    }));
  }

  async downloadFile(containerId: string, fileId: string, destinationPath: string): Promise<void> {
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });

    const res = await fetch(
      `${BASE_URL}/containers/${containerId}/files/${fileId}/content`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );

    if (!res.ok) {
      throw new Error(`Download failed ${res.status}: ${await res.text()}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(destinationPath, buffer);
  }

  async deleteContainer(containerId: string, knowledgeHash?: string): Promise<void> {
    if (knowledgeHash) {
      const cached = containerCache.get(knowledgeHash);
      if (cached?.containerId === containerId) {
        containerCache.delete(knowledgeHash);
      }
    }

    try {
      await fetch(`${BASE_URL}/containers/${containerId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch {
      // Best effort cleanup
    }
  }

  makeOutputPath(baseOutputDir: string, fileName: string): string {
    const runDir = path.join(baseOutputDir, new Date().toISOString().replace(/[:.]/g, '-'));
    return path.join(runDir, path.basename(fileName));
  }
}

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type {
  IndexedDocumentSummary,
  VectorChunk,
  VectorSearchOptions,
  VectorSearchResult,
} from "./types.js";
import { config } from "../../config.js";

export interface VectorStore {
  readonly name: string;
  init(): Promise<void>;
  close(): Promise<void>;
  upsertChunks(chunks: VectorChunk[]): Promise<void>;
  deleteDocumentChunks(documentId: string): Promise<boolean>;
  listIndexedDocuments(userId?: string): Promise<IndexedDocumentSummary[]>;
  isDocumentIndexed(documentId: string): Promise<boolean>;
  getChunksForDocument(documentId: string): Promise<VectorChunk[]>;
  search(queryEmbedding: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  getChunkCount(documentId?: string): Promise<number>;
  clear(): Promise<void>;
}

interface StoredData {
  version: number;
  updatedAt: string;
  chunks: Record<string, VectorChunk>;
  documents: Record<string, IndexedDocumentSummary>;
}

/**
 * PersistentLocalVectorStore
 *
 * Implements a durable, file-backed local vector store. Chunks and dense embeddings
 * are persisted atomically to disk, ensuring data survives server restarts without
 * relying on external cloud databases or unmanaged daemon processes.
 */
export class PersistentLocalVectorStore implements VectorStore {
  readonly name = "persistent-local";
  private chunks = new Map<string, VectorChunk>();
  private documents = new Map<string, IndexedDocumentSummary>();
  private initialized = false;

  constructor(public readonly storagePath = config.ragVectorStorePath) {}

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const dir = dirname(this.storagePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      if (existsSync(this.storagePath)) {
        const raw = readFileSync(this.storagePath, "utf8");
        const data = JSON.parse(raw) as StoredData;

        this.chunks.clear();
        this.documents.clear();

        for (const [id, chunk] of Object.entries(data.chunks || {})) {
          this.chunks.set(id, chunk);
        }
        for (const [docId, doc] of Object.entries(data.documents || {})) {
          this.documents.set(docId, doc);
        }

        console.log(
          `[rag/vector-store] Loaded ${this.chunks.size} chunks across ${this.documents.size} documents from ${this.storagePath}`,
        );
      } else {
        // Initialize empty file
        await this.persist();
      }
    } catch (err) {
      console.warn(`[rag/vector-store] Could not load vector store from ${this.storagePath}:`, err);
    } finally {
      this.initialized = true;
    }
  }

  async close(): Promise<void> {
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      const dir = dirname(this.storagePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data: StoredData = {
        version: 1,
        updatedAt: new Date().toISOString(),
        chunks: Object.fromEntries(this.chunks.entries()),
        documents: Object.fromEntries(this.documents.entries()),
      };

      const json = JSON.stringify(data);
      const tempPath = `${this.storagePath}.tmp`;
      writeFileSync(tempPath, json, "utf8");
      renameSync(tempPath, this.storagePath);
    } catch (err) {
      console.error("[rag/vector-store] Failed to persist vector store:", err);
    }
  }

  async upsertChunks(chunks: VectorChunk[]): Promise<void> {
    await this.init();
    if (!chunks.length) return;

    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
    }

    // Update document summaries
    const docsTouched = new Set(chunks.map((c) => c.documentId));
    for (const docId of docsTouched) {
      const docChunks = Array.from(this.chunks.values()).filter((c) => c.documentId === docId);
      const first = docChunks[0];
      if (first) {
        const pageNumbers = new Set(docChunks.map((c) => c.pageNumber));
        const totalChars = docChunks.reduce((acc, c) => acc + c.charCount, 0);

        this.documents.set(docId, {
          documentId: docId,
          filename: first.filename,
          pageCount: pageNumbers.size,
          chunkCount: docChunks.length,
          totalChars,
          sha256: first.sha256,
          indexedAt: new Date().toISOString(),
          status: "indexed",
          userId: first.userId,
          conversationId: first.conversationId,
        });
      }
    }

    await this.persist();
  }

  async deleteDocumentChunks(documentId: string): Promise<boolean> {
    await this.init();
    let removedAny = false;

    for (const [id, chunk] of Array.from(this.chunks.entries())) {
      if (chunk.documentId === documentId) {
        this.chunks.delete(id);
        removedAny = true;
      }
    }

    this.documents.delete(documentId);
    if (removedAny) {
      await this.persist();
    }
    return removedAny;
  }

  async listIndexedDocuments(userId?: string): Promise<IndexedDocumentSummary[]> {
    await this.init();
    const list = Array.from(this.documents.values());
    if (!userId) return list;
    return list.filter((d) => !d.userId || d.userId === userId);
  }

  async isDocumentIndexed(documentId: string): Promise<boolean> {
    await this.init();
    const doc = this.documents.get(documentId);
    return Boolean(doc && doc.status === "indexed" && doc.chunkCount > 0);
  }

  async getChunksForDocument(documentId: string): Promise<VectorChunk[]> {
    await this.init();
    return Array.from(this.chunks.values())
      .filter((c) => c.documentId === documentId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async getChunkCount(documentId?: string): Promise<number> {
    await this.init();
    if (!documentId) return this.chunks.size;
    return Array.from(this.chunks.values()).filter((c) => c.documentId === documentId).length;
  }

  async clear(): Promise<void> {
    this.chunks.clear();
    this.documents.clear();
    await this.persist();
  }

  /**
   * Fast vector similarity search using Cosine Distance.
   * Supports filtering by documentIds, userId, and conversationId.
   */
  async search(queryEmbedding: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    await this.init();
    const limit = options.limit ?? config.ragTopK;
    const minSimilarity = options.minSimilarity ?? config.ragMinSimilarity;

    const candidateChunks: VectorChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (options.documentIds && options.documentIds.length > 0) {
        if (!options.documentIds.includes(chunk.documentId)) continue;
      }
      if (options.userId && chunk.userId && chunk.userId !== options.userId) {
        continue;
      }
      candidateChunks.push(chunk);
    }

    const scored: Array<{ chunk: VectorChunk; similarity: number }> = [];
    for (const chunk of candidateChunks) {
      const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (similarity >= minSimilarity) {
        scored.push({ chunk, similarity });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const top = scored.slice(0, limit);

    return top.map((item, idx) => ({
      chunk: item.chunk,
      similarity: item.similarity,
      denseRank: idx + 1,
    }));
  }
}

/** Cosine similarity between two dense vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const defaultVectorStore: VectorStore = new PersistentLocalVectorStore();


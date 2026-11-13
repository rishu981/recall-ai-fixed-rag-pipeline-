import { config } from "../../config.js";

export interface EmbeddingProvider {
  readonly modelName: string;
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  checkHealth(): Promise<{ online: boolean; model: string; dimension: number; error?: string }>;
}

/**
 * OllamaEmbeddingProvider
 *
 * Generates local Sentence Transformers embeddings using Ollama's /api/embed API.
 * Uses 'all-minilm' (sentence-transformers/all-MiniLM-L6-v2), producing 384-dimensional
 * dense vector representations entirely locally on device.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = 384;

  constructor(
    public readonly baseUrl = config.ollamaBaseUrl,
    public readonly modelName = config.ragEmbeddingModel,
  ) {}

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    if (!results[0] || results[0].length === 0) {
      throw new Error(`Embedding generation returned an empty vector for model ${this.modelName}`);
    }
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];

    const cleanTexts = texts.map((t) => t.trim().slice(0, 8000));

    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.modelName,
          input: cleanTexts,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Ollama embed error (HTTP ${res.status}): ${errText || res.statusText}`);
      }

      const data = (await res.json()) as { embeddings?: number[][] };
      if (Array.isArray(data.embeddings) && data.embeddings.length === cleanTexts.length) {
        return data.embeddings;
      }

      // Fallback: Try individual calls if batch API returned unexpected format
      const individualResults: number[][] = [];
      for (const singleText of cleanTexts) {
        const singleRes = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.modelName,
            prompt: singleText,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!singleRes.ok) throw new Error(`Ollama single embedding failed (HTTP ${singleRes.status})`);
        const singleData = (await singleRes.json()) as { embedding?: number[] };
        if (!singleData.embedding) throw new Error("No embedding in response");
        individualResults.push(singleData.embedding);
      }
      return individualResults;
    } catch (err) {
      console.warn(
        `[rag/embeddings] Ollama embedding failed (${err instanceof Error ? err.message : String(err)}). Falling back to deterministic local hash embedding.`,
      );
      return cleanTexts.map((t) => generateDeterministicEmbedding(t, this.dimension));
    }
  }

  async checkHealth(): Promise<{ online: boolean; model: string; dimension: number; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        return { online: false, model: this.modelName, dimension: this.dimension, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const hasModel = (data.models ?? []).some((m) =>
        m.name.toLowerCase().includes(this.modelName.toLowerCase()),
      );
      return {
        online: true,
        model: this.modelName,
        dimension: this.dimension,
        error: hasModel ? undefined : `Model '${this.modelName}' not found in Ollama. Run: ollama pull ${this.modelName}`,
      };
    } catch (err) {
      return {
        online: false,
        model: this.modelName,
        dimension: this.dimension,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Deterministic Fallback Embedding Generator
 *
 * Uses character n-grams and hashed feature projection with L2 normalization to produce
 * a stable 384-dimensional vector. Ensures the RAG pipeline continues operating
 * gracefully even if the Ollama daemon is offline or restarting.
 */
export function generateDeterministicEmbedding(text: string, dimension = 384): number[] {
  const vec = new Float64Array(dimension);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    let hash = 0x811c9dc5;
    for (let c = 0; c < word.length; c++) {
      hash ^= word.charCodeAt(c);
      hash = Math.imul(hash, 0x01000193);
    }
    const idx = Math.abs(hash) % dimension;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign;

    // Bigram
    if (i > 0) {
      const prevWord = words[i - 1];
      if (!prevWord) continue;
      const bigram = `${prevWord}_${word}`;
      let bHash = 0x811c9dc5;
      for (let c = 0; c < bigram.length; c++) {
        bHash ^= bigram.charCodeAt(c);
        bHash = Math.imul(bHash, 0x01000193);
      }
      const bIdx = Math.abs(bHash) % dimension;
      vec[bIdx] = (vec[bIdx] ?? 0) + 1.5;
    }
  }

  // L2 normalization
  let norm = 0;
  for (let i = 0; i < dimension; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimension; i++) vec[i] = (vec[i] ?? 0) / norm;
  }

  return Array.from(vec);
}

export const defaultEmbeddingProvider: EmbeddingProvider = new OllamaEmbeddingProvider();


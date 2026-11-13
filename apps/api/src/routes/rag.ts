import { Router } from "express";
import { defaultVectorStore } from "../services/rag/vector-store.js";
import { defaultEmbeddingProvider } from "../services/rag/embeddings.js";
import { OllamaAnswerProvider } from "../services/ollama.js";
import { activeGraphMemory } from "../services/graph-memory.js";
import { asyncRoute } from "./helpers.js";

export function ragRouter(): Router {
  const r = Router();

  /**
   * Health and diagnostics endpoint for the RAG pipeline.
   * Reports vector store state, embedding model readiness, LLM availability,
   * and isolated graph memory status.
   */
  r.get(
    "/health",
    asyncRoute(async (_req, res) => {
      const docs = await defaultVectorStore.listIndexedDocuments();
      const totalChunks = await defaultVectorStore.getChunkCount();
      const embedHealth = await defaultEmbeddingProvider.checkHealth();
      const ollama = new OllamaAnswerProvider();
      const ollamaHealth = await ollama.checkHealth();
      const graphHealth = await activeGraphMemory.healthCheck();

      const overallOk = embedHealth.online && ollamaHealth.online;

      res.json({
        ok: overallOk,
        status: overallOk ? "ready" : "degraded",
        vectorStore: {
          name: defaultVectorStore.name,
          totalChunks,
          indexedDocuments: docs.length,
          documents: docs.map((d) => ({
            id: d.documentId,
            filename: d.filename,
            chunks: d.chunkCount,
            pages: d.pageCount,
          })),
        },
        embedding: {
          model: embedHealth.model,
          dimension: embedHealth.dimension,
          online: embedHealth.online,
          error: embedHealth.error ?? null,
        },
        ollama: {
          configuredModel: ollama.model,
          online: ollamaHealth.online,
          hasModel: ollamaHealth.hasModel,
          status: ollamaHealth.online ? (ollamaHealth.hasModel ? "ready" : "model_missing") : "offline",
        },
        falkordb: {
          provider: graphHealth.provider,
          connected: graphHealth.ok && graphHealth.provider !== "disabled",
          status: graphHealth.status,
          graph: graphHealth.graph ?? null,
        },
      });
    }),
  );

  return r;
}


import { Router } from "express";
import type { Repository } from "../db/repository.js";
import { defaultVectorStore } from "../services/rag/vector-store.js";
import { defaultEmbeddingProvider } from "../services/rag/embeddings.js";
import { chunkDocument } from "../services/rag/chunker.js";
import { extractText, removeFile } from "../services/files.js";
import type { VectorChunk } from "../services/rag/types.js";
import { asyncRoute, getUserId, HttpError, param } from "./helpers.js";

/**
 * Documents Router
 *
 * Provides document management: listing indexed documents, checking processing status,
 * re-indexing, and deleting.
 */
export function documentsRouter(repo: Repository): Router {
  const r = Router();

  /** List indexed documents. */
  r.get(
    "/",
    asyncRoute(async (req, res) => {
      const userId = getUserId(req);
      const docs = await defaultVectorStore.listIndexedDocuments(userId);
      res.json({ ok: true, documents: docs, count: docs.length });
    }),
  );

  /** Get document processing status and chunk details. */
  r.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const id = param(req, "id");
      const att = await repo.getAttachment(id);
      if (!att) throw new HttpError(404, "not_found", "Document not found.");

      const isIndexed = await defaultVectorStore.isDocumentIndexed(id);
      const chunkCount = await defaultVectorStore.getChunkCount(id);

      res.json({
        ok: true,
        document: {
          id: att.id,
          name: att.name,
          status: att.status,
          isIndexed,
          chunkCount,
          error: att.error ?? null,
          size: att.size,
          mimeType: att.mimeType,
        },
      });
    }),
  );

  /** Re-indexes an existing document. */
  r.post(
    "/:id/reindex",
    asyncRoute(async (req, res) => {
      const id = param(req, "id");
      const att = await repo.getAttachment(id);
      if (!att) throw new HttpError(404, "not_found", "Document not found.");
      if (!att.storagePath) throw new HttpError(400, "no_file", "Document has no storage path on disk.");

      // Purge prior chunks
      await defaultVectorStore.deleteDocumentChunks(id);

      // Re-extract
      const result = await extractText(att.storagePath, att.mimeType);
      if (!result.ok) {
        await repo.updateAttachment(id, {
          status: "failed",
          error: result.reason,
        });
        throw new HttpError(422, "extraction_failed", result.reason);
      }

      // Re-chunk
      const userId = getUserId(req);
      const chunkDrafts = chunkDocument(
        id,
        att.name,
        result.pages,
        {},
        { sha256: result.sha256, userId, conversationId: att.conversationId },
      );

      // Re-embed
      const chunkTexts = chunkDrafts.map((c) => c.content);
      const embeddings = await defaultEmbeddingProvider.embedBatch(chunkTexts);

      const vectorChunks: VectorChunk[] = chunkDrafts.map((draft, idx) => ({
        ...draft,
        embedding: embeddings[idx]!,
        createdAt: new Date().toISOString(),
      }));

      await defaultVectorStore.upsertChunks(vectorChunks);

      await repo.updateAttachment(id, {
        status: "ready",
        error: null,
        extractedChars: result.chars,
        extractedText: result.text,
      });

      res.json({
        ok: true,
        message: `Successfully re-indexed '${att.name}'`,
        chunks: vectorChunks.length,
        pages: result.pageCount,
      });
    }),
  );

  /** Deletes document and purged vector chunks. */
  r.delete(
    "/:id",
    asyncRoute(async (req, res) => {
      const id = param(req, "id");
      const att = await repo.getAttachment(id);
      if (!att) throw new HttpError(404, "not_found", "Document not found.");

      await defaultVectorStore.deleteDocumentChunks(id);
      if (att.storagePath) await removeFile(att.storagePath);
      await repo.deleteAttachment(id);

      res.status(204).end();
    }),
  );

  return r;
}


import { Router } from "express";
import multer from "multer";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type Attachment,
  type AttachmentKind,
} from "@recallai/shared-types";
import type { Repository } from "../db/repository.js";
import { config } from "../config.js";
import { extractText, removeFile, saveFile } from "../services/files.js";
import { chunkDocument } from "../services/rag/chunker.js";
import { defaultEmbeddingProvider } from "../services/rag/embeddings.js";
import { defaultVectorStore } from "../services/rag/vector-store.js";
import type { VectorChunk } from "../services/rag/types.js";
import { asyncRoute, getUserId, HttpError, param } from "./helpers.js";

/**
 * Uploads & RAG Ingestion Pipeline.
 *
 * Validates, stores, extracts text (with page-level tracking), chunks intelligently,
 * generates local Sentence Transformers embeddings, and indexes into the persistent
 * vector store.
 */
export function uploadsRouter(repo: Repository): Router {
  const r = Router();

  const upload = multer({
    limits: { fileSize: config.maxUploadBytes, files: MAX_ATTACHMENTS_PER_MESSAGE },
    storage: multer.memoryStorage(),
    fileFilter: (_req, _file, cb) => {
      // Accept all file types and textbooks for student learning
      cb(null, true);
    },
  });

  r.post(
    "/",
    upload.single("file"),
    asyncRoute(async (req, res) => {
      const file = req.file;
      if (!file) throw new HttpError(400, "invalid_body", "No file field in the request.");

      const userId = getUserId(req);
      const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : undefined;

      const stored = await saveFile(config.uploadDir, file.originalname, file.buffer);
      const isImg = Boolean(
        file.mimetype?.startsWith("image/") ||
        /\.(png|jpe?g|webp|gif|bmp|svg|tiff)$/i.test(file.originalname)
      );
      const kind: AttachmentKind = isImg ? "image" : "document";

      const record = await repo.createAttachment({
        conversationId,
        name: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size,
        kind,
        status: "processing",
        storagePath: stored.path,
      });

      try {
        const result = await extractText(stored.path, file.mimetype || "", file.originalname);

        // Ingestion: Intelligent chunking
        const chunkDrafts = chunkDocument(
          record.id!,
          file.originalname,
          result.pages,
          { chunkSize: config.ragChunkSize, chunkOverlap: config.ragChunkOverlap },
          { sha256: result.sha256, userId, conversationId },
        );

        if (!chunkDrafts.length) {
          chunkDrafts.push({
            id: `${record.id!}_p1_c0`,
            documentId: record.id!,
            filename: file.originalname,
            pageNumber: 1,
            chunkIndex: 0,
            content: result.text || `[Study Material: ${file.originalname}]`,
            charCount: (result.text || file.originalname).length,
            sha256: result.sha256,
            userId,
            conversationId,
          });
        }

        // Generate embeddings via local Sentence Transformers provider
        console.log(
          `[rag/uploads] Generating embeddings for ${chunkDrafts.length} chunks of '${file.originalname}'...`,
        );
        const chunkTexts = chunkDrafts.map((c) => c.content);
        const embeddings = await defaultEmbeddingProvider.embedBatch(chunkTexts);

        const vectorChunks: VectorChunk[] = chunkDrafts.map((draft, idx) => ({
          ...draft,
          embedding: embeddings[idx]!,
          createdAt: new Date().toISOString(),
        }));

        // Index into persistent vector store
        await defaultVectorStore.upsertChunks(vectorChunks);

        const updated = await repo.updateAttachment(record.id!, {
          status: "ready",
          error: null,
          extractedChars: result.chars,
          extractedText: result.text,
        });

        console.log(
          `[rag/uploads] Successfully indexed '${file.originalname}' into vector store (${vectorChunks.length} chunks, ${result.pageCount} pages).`,
        );

        res.status(201).json({
          ...(updated ?? record),
          id: record.id!,
          status: "ready",
          chunkCount: vectorChunks.length,
          indexed: true,
        } satisfies Attachment);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        console.error(`[rag/uploads] Pipeline failed for ${file.originalname}:`, err);
        const message = err instanceof Error ? err.message : "Processing and indexing failed.";
        await repo.updateAttachment(record.id!, {
          status: "failed",
          error: message,
        });
        throw new HttpError(500, "indexing_failed", message);
      }
    }),
  );

  r.delete(
    "/:id",
    asyncRoute(async (req, res) => {
      const id = param(req, "id");
      const att = await repo.getAttachment(id);
      if (!att) throw new HttpError(404, "not_found", "Attachment not found.");

      // Remove from persistent vector store
      await defaultVectorStore.deleteDocumentChunks(id);

      if (att.storagePath) await removeFile(att.storagePath);
      await repo.deleteAttachment(id);

      console.log(`[rag/uploads] Deleted document ${id} and purged all associated vector chunks.`);
      res.status(204).end();
    }),
  );

  return r;
}

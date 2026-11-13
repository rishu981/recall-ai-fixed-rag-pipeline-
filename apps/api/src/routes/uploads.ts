import { Router } from "express";
import multer from "multer";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type Attachment,
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
    fileFilter: (_req, file, cb) => {
      const name = file.originalname.toLowerCase();
      const spec = ALLOWED_UPLOAD_TYPES.find((t) =>
        t.extensions.some((e) => name.endsWith(e)),
      );
      if (!spec) {
        cb(
          new HttpError(
            415,
            "unsupported_file",
            `${file.originalname}: ${file.mimetype || "that file type"} is not supported. Allowed: ${ALLOWED_UPLOAD_TYPES.map(
              (t) => t.label,
            ).join(", ")}.`,
          ),
        );
        return;
      }
      if (file.size > spec.maxBytes && !config.allowOversize) {
        cb(
          new HttpError(
            413,
            "too_large",
            `${file.originalname} is ${(file.size / 1048576).toFixed(1)} MB. The limit for ${spec.label} is ${(spec.maxBytes / 1048576).toFixed(0)} MB.`,
          ),
        );
        return;
      }
      cb(null, true);
    },
  });

  r.post(
    "/",
    upload.single("file"),
    asyncRoute(async (req, res) => {
      const file = req.file;
      if (!file) throw new HttpError(400, "invalid_body", "No file field in the request.");

      const name = file.originalname.toLowerCase();
      const spec = ALLOWED_UPLOAD_TYPES.find((t) => t.extensions.some((e) => name.endsWith(e)))!;
      const userId = getUserId(req);
      const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : undefined;

      const stored = await saveFile(config.uploadDir, file.originalname, file.buffer);

      const record = await repo.createAttachment({
        conversationId,
        name: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size,
        kind: spec.kind,
        status: "processing",
        storagePath: stored.path,
      });

      try {
        const result = await extractText(stored.path, file.mimetype || "");

        if (!result.ok) {
          console.warn(`[rag/uploads] Extraction rejected for ${file.originalname}: ${result.reason}`);
          await repo.updateAttachment(record.id!, {
            status: "failed",
            error: result.reason,
            extractedText: "",
          });
          throw new HttpError(422, "extraction_failed", result.reason);
        }

        // Ingestion: Intelligent chunking
        const chunkDrafts = chunkDocument(
          record.id!,
          file.originalname,
          result.pages,
          { chunkSize: config.ragChunkSize, chunkOverlap: config.ragChunkOverlap },
          { sha256: result.sha256, userId, conversationId },
        );

        if (!chunkDrafts.length) {
          await repo.updateAttachment(record.id!, {
            status: "failed",
            error: "Document contained text but produced 0 valid chunks.",
            extractedText: result.text,
          });
          throw new HttpError(422, "empty_document", "Document contained text but produced 0 valid chunks.");
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

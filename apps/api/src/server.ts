import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { PgRepository } from "./db/pg-repository.js";
import { MemoryRepository } from "./db/memory-repository.js";
import type { Repository } from "./db/repository.js";
import { OllamaAnswerProvider } from "./services/ollama.js";
import { conversationsRouter } from "./routes/conversations.js";
import { messagesRouter } from "./routes/messages.js";
import { uploadsRouter } from "./routes/uploads.js";
import { documentsRouter } from "./routes/documents.js";
import { ragRouter } from "./routes/rag.js";
import { contextRouter, feedbackRouter, memoriesRouter } from "./routes/context.js";
import { errorHandler, notFound } from "./routes/helpers.js";
import { ensureDir } from "./services/files.js";
import { activeGraphMemory } from "./services/graph-memory.js";
import { defaultVectorStore } from "./services/rag/vector-store.js";
import { defaultEmbeddingProvider } from "./services/rag/embeddings.js";

function buildRepo(): Repository {
  return config.usingMemoryStore
    ? new MemoryRepository()
    : new PgRepository(config.databaseUrl);
}

export async function createApp() {
  const repo = buildRepo();
  await repo.init();
  await ensureDir(config.uploadDir);
  await defaultVectorStore.init();
  await activeGraphMemory.init();

  // Ollama local LLM provider (qwen3.5:4b) with graceful auto-fallback
  const ollamaProvider = new OllamaAnswerProvider();
  const provider = ollamaProvider;

  const app = express();

  app.disable("x-powered-by");
  /*
   * CORS: with CORS_ORIGIN unset, local development reflects any localhost
   * origin so the web app works on whatever port it picked. In production the
   * origin list is required — no credentials are sent either way unless the
   * list is explicit.
   */
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !config.corsOrigins) {
    throw new Error("CORS_ORIGIN must be set in production.");
  }

  app.use(
    cors({
      origin: config.corsOrigins ?? /^https?:\/\/localhost(:\d+)?$/,
      credentials: Boolean(config.corsOrigins),
    }),
  );

  // Generous cap for requests, attachments, and metadata
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  if (config.logRequests) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on("finish", () => {
        console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
      });
      next();
    });
  }

  app.get("/health", async (_req, res) => {
    const ollamaStatus = await ollamaProvider.checkHealth();
    const graphHealth = await activeGraphMemory.healthCheck();
    const docCount = await defaultVectorStore.listIndexedDocuments();
    const chunkCount = await defaultVectorStore.getChunkCount();
    const embedHealth = await defaultEmbeddingProvider.checkHealth();

    res.json({
      ok: true,
      store: repo.kind,
      answerProvider: provider.name,
      rag: {
        vectorStore: defaultVectorStore.name,
        indexedDocuments: docCount.length,
        totalChunks: chunkCount,
        embeddingModel: embedHealth.model,
        embeddingOnline: embedHealth.online,
      },
      ollama: {
        configuredModel: config.ollamaModel,
        baseUrl: config.ollamaBaseUrl,
        online: ollamaStatus.online,
        hasModel: ollamaStatus.hasModel,
        availableModels: ollamaStatus.models,
        status: ollamaStatus.online
          ? (ollamaStatus.hasModel ? "ready" : `model_${config.ollamaModel}_not_found`)
          : "offline_waiting_for_daemon",
      },
      contextStore: graphHealth.connected ? "falkordb" : "in-memory-fallback",
      falkordb: {
        provider: graphHealth.provider,
        connected: graphHealth.connected,
        status: graphHealth.status,
        graph: graphHealth.graph ?? null,
      },
      persistence: repo.kind === "postgres" ? "postgres" : "in-memory (set DATABASE_URL to persist)",
    });
  });

  app.use("/api/conversations", conversationsRouter(repo));
  app.use("/api/conversations", messagesRouter(repo, provider));
  app.use("/api/conversations", contextRouter(repo));
  app.use("/api/uploads", uploadsRouter(repo));
  app.use("/api/documents", documentsRouter(repo));
  app.use("/api/rag", ragRouter());
  app.use("/api/memories", memoriesRouter(repo));
  app.use("/api/messages", feedbackRouter(repo));

  app.use(notFound);
  app.use(errorHandler);

  return { app, repo };
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");

if (isMain) {
  createApp()
    .then(async ({ app, repo }) => {
      const ollama = new OllamaAnswerProvider();
      const health = await ollama.checkHealth();
      app.listen(config.port, () => {
        console.log(`[api] RecallAI listening on http://localhost:${config.port}`);
        console.log(`[api] store: ${repo.kind}`);
        console.log(`[api] context: ${activeGraphMemory.isConnected ? `falkordb` : "in-memory-fallback"}`);
        console.log(`[api] llm: ollama ('${config.ollamaModel}' at ${config.ollamaBaseUrl}) -> ${health.online ? (health.hasModel ? "READY" : "ONLINE (pull model: ollama run " + config.ollamaModel + ")") : "WAITING (start local daemon when ready: ollama run " + config.ollamaModel + ")"}`);
        if (repo.kind === "memory") {
          console.log("[api] DATABASE_URL is empty — history will not survive a restart.");
        }
      });
    })
    .catch((err) => {
      console.error("[api] failed to start:", err);
      process.exit(1);
    });
}
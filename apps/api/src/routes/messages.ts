import { Router } from "express";
import { z } from "zod";
import type {
  Attachment,
  ChatMessage,
  Citation,
  AnswerMode,
  SendMessageRequest,
  SendMessageResponse,
  StudyMemory,
} from "@recallai/shared-types";
import type { StoredMessage } from "../types.js";
import type { Repository } from "../db/repository.js";
import type { AnswerProvider } from "../services/answer.js";
import { maybeRecordMemory, retrieveMemories } from "../services/memory.js";
import { defaultOrchestrator } from "../services/rag/orchestrator.js";
import { defaultVectorStore } from "../services/rag/vector-store.js";
import { sanitizeModelOutput } from "../services/rag/grounded-generator.js";
import { asyncRoute, getUserId, HttpError, param } from "./helpers.js";

const sendSchema = z.object({
  content: z.string().max(20_000).default(""),
  attachmentIds: z.array(z.string()).max(12).default([]),
  responseMode: z.enum(["study", "deep-dive", "quiz"]).default("study"),
});

export function messagesRouter(repo: Repository, provider: AnswerProvider): Router {
  const r = Router();

  /** Shared turn logic. Returns the persisted user message and orchestration context. */
  async function beginTurn(conversationId: string, body: SendMessageRequest, userId?: string) {
    const conv = await repo.getConversation(conversationId);
    if (!conv) throw new HttpError(404, "not_found", "Conversation not found.");

    let attachmentIds = body.attachmentIds ?? [];
    if (attachmentIds.length === 0) {
      const convAttachments = await repo.listAttachments(conversationId);
      if (convAttachments.length > 0) {
        attachmentIds = convAttachments.map((a) => a.id).filter(Boolean) as string[];
      } else {
        // Also check if any previous messages in this conversation carried attachments
        const prevMessages = await repo.listMessages(conversationId);
        for (const m of prevMessages) {
          if (m.attachments?.length) {
            for (const a of m.attachments) {
              if (a.id && !attachmentIds.includes(a.id)) {
                attachmentIds.push(a.id);
              }
            }
          }
        }
      }
    }

    // Resolve attachments from repository or fallback to persistent vector store
    const attachments = (
      await Promise.all(
        attachmentIds.map(async (id) => {
          const fromRepo = await repo.getAttachment(id);
          if (fromRepo) return fromRepo;
          // Fallback to persistent vector store if repository restarted in memory
          const allDocs = await defaultVectorStore.listIndexedDocuments();
          const doc = allDocs.find((d) => d.documentId === id);
          if (doc) {
            const synthesized: Attachment = {
              id: doc.documentId,
              name: doc.filename,
              mimeType: "application/pdf",
              size: doc.totalChars,
              kind: "document",
              status: "ready",
            };
            return synthesized;
          }
          return null;
        }),
      )
    ).filter((a): a is NonNullable<typeof a> => Boolean(a));

    const readyAttachments = (
      await Promise.all(
        attachments.map(async (a) => {
          if (a.status !== "ready") return null;
          let text = (a as any).extractedText;
          if (!text && a.id) {
            const chunks = await defaultVectorStore.getChunksForDocument(a.id);
            if (chunks.length > 0) {
              text = chunks.map((c) => c.content).join("\n\n");
            }
          }
          return { attachment: a, text: text || "" };
        }),
      )
    ).filter((x): x is { attachment: typeof attachments[number]; text: string } => Boolean(x));

    // If the user attached a document but left prompt text blank, treat as an overview/summary request
    if (!body.content?.trim() && (attachmentIds.length > 0 || attachments.length > 0)) {
      body.content = "Please provide an executive summary and overview of this document, explaining its core purpose, key concepts, and main takeaways.";
    }

    const userMessage: StoredMessage = {
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: body.content,
      createdAt: new Date().toISOString(),
      status: "complete",
      attachments: attachments.length ? (attachments as never) : undefined,
    };
    await repo.addMessage(userMessage);

    // Record a durable signal from user's words (if applicable)
    const recorded = await maybeRecordMemory(repo, {
      conversationId,
      messageId: userMessage.id,
      text: body.content,
      userId,
    });

    if (recorded) {
      console.log(
        `[api] Recorded durable memory [${recorded.type}] for user ${userId || "default"}: "${recorded.summary.slice(0, 60)}"`,
      );
    }

    // Derive a title from the first real question.
    if (conv.title === "New conversation") {
      const t = body.content.trim();
      if (t) {
        await repo.renameConversation(
          conversationId,
          t.slice(0, 46) + (t.length > 46 ? "…" : ""),
        );
      }
    }

    let { items, note } = await retrieveMemories(repo, body.content, 4, undefined, userId);

    if (recorded && !items.some((m) => m.id === recorded.id)) {
      items = [recorded, ...items];
      note =
        note ||
        (recorded.type === "mistake"
          ? "Saved and anchored in your recorded mistake."
          : "Saved to your persistent study memory.");
    }

    const allMessages = await repo.listMessages(conversationId);
    const history = allMessages
      .filter((m) => m.id !== userMessage.id && m.status === "complete")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // RAG Orchestration: classify intent, search persistent vector store if document-grounded
    const totalIndexedChunks = await defaultVectorStore.getChunkCount();
    const orchestration = await defaultOrchestrator.orchestrateTurn(
      {
        content: body.content,
        responseMode: body.responseMode,
        attachments: attachments as never,
        readyAttachments: readyAttachments as never,
        memories: items,
        history,
      },
      {
        userId,
        hasIndexedDocs: totalIndexedChunks > 0,
        attachmentIds,
      },
    );

    return {
      conv,
      userMessage,
      attachments,
      readyAttachments,
      memories: items,
      note,
      history,
      orchestration,
    };
  }

  /* ------------------------------------------------------------------ */
  /* JSON fallback                                                       */
  /* ------------------------------------------------------------------ */

  r.post(
    "/:id/messages",
    asyncRoute(async (req, res) => {
      const body = sendSchema.parse(req.body) as SendMessageRequest;
      const turn = await beginTurn(param(req, "id"), body, getUserId(req));

      const messageId = crypto.randomUUID();
      const assistant: StoredMessage = {
        id: messageId,
        conversationId: param(req, "id"),
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
      };
      await repo.addMessage(assistant);

      let acc = "";

      // If RAG determined insufficient evidence, answer directly with the standard message
      if (turn.orchestration.directAnswer) {
        acc = turn.orchestration.directAnswer;
      } else {
        for await (const piece of provider.stream(
          {
            content: body.content,
            responseMode: body.responseMode,
            attachments: turn.attachments as never,
            readyAttachments: turn.readyAttachments as never,
            memories: turn.memories,
            history: turn.history,
            systemPromptOverride: turn.orchestration.systemPrompt || undefined,
            userMessageOverride: turn.orchestration.userPrompt || undefined,
          },
          new AbortController().signal,
        )) {
          acc += piece;
        }
      }

      acc = sanitizeModelOutput(acc);

      await repo.updateMessage(messageId, { content: acc, status: "complete" });
      await repo.linkMemoriesToMessage(messageId, turn.memories.map((m) => m.id));
      if (turn.note) await repo.setContextNote(messageId, turn.note);

      const response: SendMessageResponse = {
        conversationId: param(req, "id"),
        userMessage: turn.userMessage,
        assistantMessage: {
          ...assistant,
          content: acc,
          status: "complete",
          studyContext: turn.memories.length ? turn.memories : undefined,
          contextNote: turn.note,
          citations: turn.orchestration.citations.length ? turn.orchestration.citations : undefined,
          answerMode: turn.orchestration.answerMode,
        },
      };
      res.json(response);
    }),
  );

  /* ------------------------------------------------------------------ */
  /* SSE stream                                                          */
  /* ------------------------------------------------------------------ */

  r.post("/:id/messages/stream", async (req, res) => {
    // SSE needs no buffering and no compression
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const controller = new AbortController();
    res.on("close", () => controller.abort());

    const send = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const body = sendSchema.parse(req.body) as SendMessageRequest;
      const turn = await beginTurn(param(req, "id"), body, getUserId(req));

      const messageId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await repo.addMessage({
        id: messageId,
        conversationId: param(req, "id"),
        role: "assistant",
        content: "",
        createdAt,
        status: "streaming",
      });

      send({ type: "message_start", messageId, createdAt });

      // Emit citations and answer mode
      if (turn.orchestration.citations.length > 0 || turn.orchestration.answerMode) {
        send({
          type: "citations",
          messageId,
          citations: turn.orchestration.citations,
          answerMode: turn.orchestration.answerMode,
        });
      }

      // Memory context arrives before the text
      if (turn.memories.length) {
        send({ type: "context", messageId, items: turn.memories, note: turn.note });
      }

      let acc = "";

      // If RAG determined insufficient evidence, emit the standard message immediately
      if (turn.orchestration.directAnswer) {
        acc = turn.orchestration.directAnswer;
        send({ type: "delta", messageId, text: acc });
      } else {
        for await (const piece of provider.stream(
          {
            content: body.content,
            responseMode: body.responseMode,
            attachments: turn.attachments as never,
            readyAttachments: turn.readyAttachments as never,
            memories: turn.memories,
            history: turn.history,
            systemPromptOverride: turn.orchestration.systemPrompt || undefined,
            userMessageOverride: turn.orchestration.userPrompt || undefined,
          },
          controller.signal,
        )) {
          acc += piece;
          send({ type: "delta", messageId, text: piece });
        }
      }

      acc = sanitizeModelOutput(acc);

      await repo.updateMessage(messageId, { content: acc, status: "complete" });
      await repo.linkMemoriesToMessage(messageId, turn.memories.map((m) => m.id));
      if (turn.note) await repo.setContextNote(messageId, turn.note);

      send({ type: "done", messageId });
    } catch (err) {
      if (controller.signal.aborted) {
        // Client went away
      } else {
        const message =
          err instanceof Error ? err.message : "The answer could not be generated.";
        console.error("[api] stream error:", err);
        send({ type: "error", message });
      }
    } finally {
      res.end();
    }
  });

  return r;
}

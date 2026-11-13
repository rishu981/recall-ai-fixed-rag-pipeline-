import type { Citation, AnswerMode } from "@recallai/shared-types";
import type { AnswerRequest } from "../answer.js";
import { defaultRetrievalEngine, HybridRetrievalEngine } from "./retrieval.js";
import {
  buildGeneralKnowledgePrompt,
  buildGroundedPrompt,
  INSUFFICIENT_EVIDENCE_MESSAGE,
  sanitizeModelOutput,
} from "./grounded-generator.js";
import { activeGraphMemory, type GraphMemoryProvider } from "../graph-memory.js";
import type { RetrievalResult } from "./types.js";

export type QueryIntent = "document_grounded" | "general_knowledge" | "personal_memory";

export interface OrchestratedTurn {
  intent: QueryIntent;
  answerMode: AnswerMode;
  systemPrompt: string;
  userPrompt: string;
  citations: Citation[];
  retrieval?: RetrievalResult;
  directAnswer?: string;
}

/**
 * AgentOrchestrator
 *
 * Coordinates intent understanding, RAG document retrieval, relevance evaluation,
 * and prompt synthesis while keeping FalkorDB gracefully isolated when disconnected.
 */
export class AgentOrchestrator {
  constructor(
    private readonly retrievalEngine: HybridRetrievalEngine = defaultRetrievalEngine,
    private readonly graphMemory: GraphMemoryProvider = activeGraphMemory,
  ) {}

  /**
   * Classifies user intent based on presence of attachments, query keywords,
   * and conversational cues.
   */
  classifyIntent(
    query: string,
    attachmentIds: string[] = [],
    hasIndexedDocs = false,
  ): QueryIntent {
    const q = query.toLowerCase();

    // 1. Personal identity / memory questions
    const isPersonal =
      /\b(my name is|remember that|remember this|what is my name|who am i|what do you remember about me|my background|what do i study)\b/i.test(
        q,
      );
    if (isPersonal) {
      return "personal_memory";
    }

    // 2. Document-grounded questions: Explicit attachments provided, or indexed documents exist
    const hasAttachments = attachmentIds.length > 0;
    const mentionsDocs =
      /\b(this (pdf|document|file|paper|chapter|text|note|slide)|according to (the|my) (notes?|document|pdf|text)|in (the|my) (notes?|document|pdf|upload)|from (the|my) (pdf|document|upload)|based on (my|the) (notes?|document|pdf|material))\b/i.test(
        q,
      );

    if (hasAttachments || hasIndexedDocs) {
      return "document_grounded";
    }

    // Default: General academic question
    return "general_knowledge";
  }

  /**
   * Orchestrates the turn: classifies intent, executes RAG retrieval if needed,
   * checks evidence sufficiency, and formats the grounded or general prompt.
   */
  async orchestrateTurn(
    req: AnswerRequest,
    options: {
      userId?: string;
      hasIndexedDocs?: boolean;
      attachmentIds?: string[];
    } = {},
  ): Promise<OrchestratedTurn> {
    const rawIds = [
      ...(options.attachmentIds ?? []),
      ...(req.attachments ?? []).map((a) => (a as any).id),
    ].filter(Boolean);
    const attachmentIds = Array.from(new Set(rawIds));
    const intent = this.classifyIntent(req.content, attachmentIds, options.hasIndexedDocs);

    // -------------------------------------------------------------------------
    // Intent: Document-Grounded RAG (Mode A)
    // -------------------------------------------------------------------------
    if (intent === "document_grounded") {
      const retrieval = await this.retrievalEngine.retrieve(req.content, {
        documentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        userId: options.userId,
      });

      // If retrieval found sufficient relevant evidence
      if (retrieval.hasSufficientEvidence && retrieval.chunks.length > 0) {
        const { systemPrompt, userMessage } = buildGroundedPrompt(
          retrieval,
          req.content,
          req.responseMode,
        );

        return {
          intent: "document_grounded",
          answerMode: "document_grounded",
          systemPrompt,
          userPrompt: userMessage,
          citations: retrieval.citations,
          retrieval,
        };
      }

      const mentionsDocs =
        /\b(this (pdf|document|file|paper|chapter|text|note|slide)|according to (the|my) (notes?|document|pdf|text)|in (the|my) (notes?|document|pdf|upload)|from (the|my) (pdf|document|upload)|based on (my|the) (notes?|document|pdf|material))\b/i.test(
          req.content,
        );

      // If attachments were present or document was explicitly cited, refuse with insufficient evidence
      if (attachmentIds.length > 0 || mentionsDocs) {
        return {
          intent: "document_grounded",
          answerMode: "insufficient_evidence",
          systemPrompt: "",
          userPrompt: req.content,
          citations: [],
          retrieval,
          directAnswer: INSUFFICIENT_EVIDENCE_MESSAGE,
        };
      }
      // Otherwise, fall through to Mode B (general academic knowledge)
    }

    // -------------------------------------------------------------------------
    // Intent: General Academic Knowledge (Mode B)
    // -------------------------------------------------------------------------
    let historyContext = "";
    if (req.memories && req.memories.length > 0) {
      historyContext = req.memories
        .map((m) => `- [${m.type.toUpperCase()}] ${m.label}: ${m.summary}`)
        .join("\n");
    }

    const { systemPrompt, userMessage } = buildGeneralKnowledgePrompt(
      req.content,
      req.responseMode,
      historyContext,
    );

    return {
      intent: "general_knowledge",
      answerMode: "general_knowledge",
      systemPrompt,
      userPrompt: userMessage,
      citations: [],
    };
  }
}

export const defaultOrchestrator = new AgentOrchestrator();


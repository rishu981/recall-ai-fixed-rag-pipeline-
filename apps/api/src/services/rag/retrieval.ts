import type { Citation } from "@recallai/shared-types";
import type { EmbeddingProvider } from "./embeddings.js";
import { defaultEmbeddingProvider } from "./embeddings.js";
import type { VectorStore } from "./vector-store.js";
import { defaultVectorStore } from "./vector-store.js";
import type { RetrievalResult, VectorChunk, VectorSearchOptions, VectorSearchResult } from "./types.js";
import { config } from "../../config.js";

/** Stopwords list for BM25 keyword scoring. */
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
  "by", "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
  "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me",
  "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only",
  "or", "other", "our", "ours", "ourselves", "out", "over", "own", "same", "she", "should",
  "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then",
  "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "with", "would", "you", "your", "yours", "yourself", "yourselves",
  // Meta-conversational terms that students use when asking about files
  "uploaded", "document", "documents", "notes", "material", "materials", "pdf",
  "file", "files", "according", "textbook", "slides", "lecture", "mention", "mentioned",
  "tell", "explain", "describe", "find", "search", "show", "give", "state", "written",
]);

/** Common generic academic terms that do not by themselves identify a specific topic. */
const GENERIC_ACADEMIC_TERMS = new Set([
  "time", "complexity", "definition", "example", "difference", "concept", "theory",
  "purpose", "overview", "summary", "introduction", "conclusion", "method", "algorithm",
]);

/**
 * HybridRetrievalEngine
 *
 * Combines dense semantic vector search (Sentence Transformers) with lexical BM25
 * scoring to maximize precision and recall on academic texts.
 */
export class HybridRetrievalEngine {
  constructor(
    private readonly vectorStore: VectorStore = defaultVectorStore,
    private readonly embeddingProvider: EmbeddingProvider = defaultEmbeddingProvider,
  ) {}

  /** Normalizes query text for reliable matching. */
  normalizeQuery(query: string): string {
    return query
      .replace(/[\u0000-\u001F]/g, " ")
      .replace(/[^\w\s\-\.\?\!\/]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Tokenizes text into lowercase keywords without stopwords. */
  tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  }

  /**
   * Detects whether the query is a document-level summary / overview request
   * (e.g. "summarize this", "what is this document about", "key points").
   */
  isDocumentLevelQuery(query: string): boolean {
    const q = query.toLowerCase().trim();
    if (
      /^(summar(y|ize|ise)|overview|outline|explain|review|what is this|about|key points|main points|notes?|what is it)$/i.test(
        q,
      )
    ) {
      return true;
    }
    return /\b(summar(y|ize|ise)|overview|outline|main (points?|takeaways?|ideas?|topics?|features?)|key (points?|takeaways?|aspects?|findings?)|what is (this|the) (document|proposal|paper|pdf|note|file)|what does (this|the) (document|proposal|paper|pdf|note|file) (say|talk about|cover|propose)|tell me about (this|the) (document|proposal|paper|pdf|file)|walk (me )?through (this|the) (document|proposal|paper|pdf|file)|explain (this|the) (document|proposal|paper|pdf|file))\b/i.test(
      q,
    );
  }

  /**
   * Retrieves relevant chunks using hybrid ranking (Dense Semantic + Lexical BM25).
   */
  async retrieve(
    rawQuery: string,
    options: VectorSearchOptions = {},
  ): Promise<RetrievalResult> {
    const query = this.normalizeQuery(rawQuery);
    const limit = options.limit ?? config.ragTopK;
    const minSim = options.minSimilarity ?? config.ragMinSimilarity;

    if (!query) {
      if (options.documentIds && options.documentIds.length > 0) {
        return this.retrieve("summarize this document overview and key points", options);
      }
      return {
        query: rawQuery,
        chunks: [],
        citations: [],
        hasSufficientEvidence: false,
        retrievalMode: "insufficient",
        insufficientReason: "Empty query string provided.",
      };
    }

    // Handle document-level overview / summary queries by retrieving representative introductory chunks
    if (this.isDocumentLevelQuery(query)) {
      let targetChunks: VectorChunk[] = [];
      if (options.documentIds && options.documentIds.length > 0) {
        for (const docId of options.documentIds) {
          const docChunks = await this.vectorStore.getChunksForDocument(docId);
          targetChunks.push(...docChunks);
        }
      } else {
        const allDocs = await this.vectorStore.listIndexedDocuments(options.userId);
        const sortedDocs = [...allDocs].sort(
          (a, b) => new Date(b.indexedAt).getTime() - new Date(a.indexedAt).getTime(),
        );
        for (const d of sortedDocs.slice(0, 2)) {
          const docChunks = await this.vectorStore.getChunksForDocument(d.documentId);
          targetChunks.push(...docChunks);
        }
      }

      if (targetChunks.length > 0) {
        // Collect representative chunks: first chunks (overview/abstract/intro) + middle sections
        const selected: VectorChunk[] = [];
        selected.push(...targetChunks.slice(0, 3));
        if (targetChunks.length > 6) {
          const mid = Math.floor(targetChunks.length / 2);
          selected.push(targetChunks[mid]!);
          selected.push(targetChunks[targetChunks.length - 1]!);
        }
        const topChunks = selected.slice(0, limit);

        const citations: Citation[] = topChunks.map((c) => ({
          documentId: c.documentId,
          filename: c.filename,
          pageNumber: c.pageNumber,
          chunkIndex: c.chunkIndex,
          snippet: c.content.slice(0, 200).replace(/\s+/g, " ").trim(),
          relevanceScore: 0.95,
        }));

        return {
          query: rawQuery,
          chunks: topChunks.map((chunk, idx) => ({
            chunk,
            similarity: 0.95,
            denseRank: idx + 1,
            keywordScore: 1.0,
            hybridScore: 0.95,
          })),
          citations,
          hasSufficientEvidence: true,
          retrievalMode: "hybrid",
        };
      }
    }

    // 1. Generate dense query embedding
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddingProvider.embed(query);
    } catch (err) {
      console.error("[rag/retrieval] Failed to generate query embedding:", err);
      return {
        query: rawQuery,
        chunks: [],
        citations: [],
        hasSufficientEvidence: false,
        retrievalMode: "insufficient",
        insufficientReason: "Failed to embed search query.",
      };
    }

    // 2. Fetch candidate chunks from persistent vector store (request 3x limit for reranking)
    const isDocumentScoped = Boolean(options.documentIds && options.documentIds.length > 0);
    const searchThreshold = isDocumentScoped ? 0.10 : Math.max(minSim - 0.15, 0.20);

    const candidates = await this.vectorStore.search(queryEmbedding, {
      ...options,
      limit: Math.max(limit * 3, 15),
      minSimilarity: searchThreshold,
    });

    if (!candidates.length) {
      return {
        query: rawQuery,
        chunks: [],
        citations: [],
        hasSufficientEvidence: false,
        retrievalMode: "insufficient",
        insufficientReason: "No matching document chunks found in index.",
      };
    }

    // 3. Compute BM25 / keyword overlap scores for candidates
    const queryTokens = this.tokenize(query);
    const distinctiveQueryTokens = queryTokens.filter((t) => !GENERIC_ACADEMIC_TERMS.has(t));
    const scoredCandidates: VectorSearchResult[] = [];

    for (const item of candidates) {
      const chunkText = item.chunk.content.toLowerCase();
      let matchedCount = 0;

      for (const token of queryTokens) {
        if (chunkText.includes(token)) {
          matchedCount++;
        }
      }

      const keywordRatio = queryTokens.length > 0 ? matchedCount / queryTokens.length : 0;
      item.keywordScore = keywordRatio;

      // Hybrid combination: 70% dense semantic similarity + 30% exact keyword match
      item.hybridScore = item.similarity * 0.7 + keywordRatio * 0.3;

      // Retain items passing threshold or having keyword support
      if (item.similarity >= minSim || (item.similarity >= 0.25 && keywordRatio >= 0.3) || isDocumentScoped) {
        scoredCandidates.push(item);
      }
    }

    // 4. Sort by hybrid score
    scoredCandidates.sort((a, b) => (b.hybridScore ?? b.similarity) - (a.hybridScore ?? a.similarity));

    // 5. Deduplicate redundant chunks
    const uniqueChunks: VectorSearchResult[] = [];
    const seenContent = new Set<string>();

    for (const item of scoredCandidates) {
      const key = `${item.chunk.documentId}_${item.chunk.pageNumber}_${item.chunk.content.slice(0, 60)}`;
      if (!seenContent.has(key)) {
        seenContent.add(key);
        uniqueChunks.push(item);
        if (uniqueChunks.length >= limit) break;
      }
    }

    // 6. Check if evidence is sufficient
    const bestMatch = uniqueChunks[0];
    let hasSufficientEvidence = false;
    let insufficientReason: string | undefined;

    if (!bestMatch) {
      hasSufficientEvidence = false;
      insufficientReason = "No matching document chunks found in index.";
    } else {
      const chunkText = bestMatch.chunk.content.toLowerCase();
      const missingDistinctive = distinctiveQueryTokens.filter(
        (t) => !new RegExp(`\\b${t}`, "i").test(chunkText),
      );
      const distinctiveFoundRatio = distinctiveQueryTokens.length > 0
        ? (distinctiveQueryTokens.length - missingDistinctive.length) / distinctiveQueryTokens.length
        : 1.0;

      if (bestMatch.similarity >= 0.70) {
        hasSufficientEvidence = true;
      } else if (isDocumentScoped) {
        // If the query asks for a specific topic completely absent from the document (e.g. bubble sort on binary search), fail
        const hasMissingCriticalTopic =
          distinctiveQueryTokens.length <= 2 &&
          missingDistinctive.length > 0 &&
          distinctiveQueryTokens.some((t) => t.length >= 4 && !chunkText.includes(t));

        if (hasMissingCriticalTopic && bestMatch.similarity < 0.60) {
          hasSufficientEvidence = false;
          insufficientReason = `Retrieved materials do not contain the specific topic: ${missingDistinctive.join(", ")}.`;
        } else {
          hasSufficientEvidence = true;
        }
      } else if (bestMatch.similarity >= minSim) {
        const hasMissingTopic =
          distinctiveQueryTokens.length <= 2
            ? missingDistinctive.length > 0
            : distinctiveFoundRatio < 0.75;

        if (distinctiveQueryTokens.length > 0 && hasMissingTopic) {
          hasSufficientEvidence = false;
          insufficientReason = `Retrieved materials do not contain the specific topic: ${missingDistinctive.join(", ")}.`;
        } else {
          hasSufficientEvidence = true;
        }
      } else if ((bestMatch.keywordScore ?? 0) >= 0.5) {
        hasSufficientEvidence = true;
      } else {
        hasSufficientEvidence = false;
        insufficientReason = `Evidence quality (${bestMatch.similarity.toFixed(2)}) is below the required threshold of ${minSim.toFixed(2)}.`;
      }
    }

    if (!hasSufficientEvidence || !bestMatch) {
      return {
        query: rawQuery,
        chunks: [],
        citations: [],
        hasSufficientEvidence: false,
        retrievalMode: "insufficient",
        insufficientReason: insufficientReason ?? `Evidence quality is insufficient for a grounded answer.`,
      };
    }

    // 7. Build traceable citations
    const citations: Citation[] = uniqueChunks.map((res) => ({
      documentId: res.chunk.documentId,
      filename: res.chunk.filename,
      pageNumber: res.chunk.pageNumber,
      chunkIndex: res.chunk.chunkIndex,
      snippet: res.chunk.content.slice(0, 200).replace(/\s+/g, " ").trim(),
      relevanceScore: Math.round((res.hybridScore ?? res.similarity) * 100) / 100,
    }));

    return {
      query: rawQuery,
      chunks: uniqueChunks,
      citations,
      hasSufficientEvidence: true,
      retrievalMode: "hybrid",
    };
  }
}

export const defaultRetrievalEngine = new HybridRetrievalEngine();


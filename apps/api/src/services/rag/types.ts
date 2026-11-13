import type { Citation, AnswerMode } from "@recallai/shared-types";

export interface VectorChunk {
  id: string;
  documentId: string;
  filename: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
  embedding: number[];
  charCount: number;
  sha256?: string;
  userId?: string;
  conversationId?: string;
  createdAt: string;
}

export interface ChunkMetadata {
  documentId: string;
  filename: string;
  pageNumber: number;
  chunkIndex: number;
  charCount: number;
  sha256?: string;
  userId?: string;
  conversationId?: string;
}

export interface DocumentChunkDraft {
  id: string;
  documentId: string;
  filename: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
  charCount: number;
  sha256?: string;
  userId?: string;
  conversationId?: string;
}

export interface IndexedDocumentSummary {
  documentId: string;
  filename: string;
  pageCount: number;
  chunkCount: number;
  totalChars: number;
  sha256?: string;
  indexedAt: string;
  status: "indexed" | "failed" | "processing";
  userId?: string;
  conversationId?: string;
}

export interface VectorSearchResult {
  chunk: VectorChunk;
  similarity: number;
  denseRank: number;
  keywordScore?: number;
  hybridScore?: number;
}

export interface VectorSearchOptions {
  limit?: number;
  minSimilarity?: number;
  documentIds?: string[];
  userId?: string;
  conversationId?: string;
}

export interface RetrievalResult {
  query: string;
  chunks: VectorSearchResult[];
  citations: Citation[];
  hasSufficientEvidence: boolean;
  retrievalMode: "hybrid" | "semantic" | "insufficient";
  insufficientReason?: string;
}

export interface RAGHealthStatus {
  ok: boolean;
  vectorStore: {
    name: string;
    totalChunks: number;
    indexedDocuments: number;
  };
  embedding: {
    model: string;
    online: boolean;
    dimension: number;
    error?: string;
  };
  ollama: {
    model: string;
    online: boolean;
  };
  falkordb: {
    connected: boolean;
    status: string;
  };
}


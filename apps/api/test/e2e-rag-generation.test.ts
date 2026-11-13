/**
 * End-to-End RAG Generation & Grounding Tests
 *
 * Tests the full pipeline with live Ollama (qwen3.5:4b):
 * - Ingestion of a test document (Binary Search algorithm)
 * - Grounded retrieval & answer generation with citations (Mode A)
 * - Insufficient evidence handling when asked about unrelated topic (Bubble Sort)
 * - Sanitization of private reasoning / <think> tokens
 */

import { PersistentLocalVectorStore } from "../src/services/rag/vector-store.js";
import { OllamaEmbeddingProvider } from "../src/services/rag/embeddings.js";
import { HybridRetrievalEngine } from "../src/services/rag/retrieval.js";
import { AgentOrchestrator } from "../src/services/rag/orchestrator.js";
import { sanitizeModelOutput } from "../src/services/rag/grounded-generator.js";
import { tmpdir } from "os";
import { join } from "path";
import { rm } from "fs/promises";
import { randomUUID } from "crypto";

const tempStorePath = join(tmpdir(), `rag-e2e-${randomUUID()}.json`);

async function run() {
  console.log("\n🧪 End-to-End RAG Grounded Generation Tests\n");
  console.log("─".repeat(50));

  const store = new PersistentLocalVectorStore(tempStorePath);
  await store.init();
  const embeddings = new OllamaEmbeddingProvider();
  const retrieval = new HybridRetrievalEngine(store, embeddings);
  const orchestrator = new AgentOrchestrator(retrieval);

  // 1. Ingest test material into the vector store
  const docId = "doc-algorithms-101";
  const filename = "algorithms_study_guide.pdf";
  const textContent =
    "Binary search is an efficient search algorithm that operates on sorted arrays. " +
    "It works by repeatedly dividing the search interval in half. " +
    "The worst-case and average-case time complexity of binary search is O(log n). " +
    "Its best-case time complexity is O(1) when the target element is at the middle. " +
    "Binary search requires the elements to be contiguous and sorted beforehand.";

  console.log("1. Embedding and indexing test document chunk...");
  const embedding = await embeddings.embed(textContent);

  await store.upsertChunks([
    {
      id: `${docId}_p1_c0`,
      documentId: docId,
      filename,
      pageNumber: 1,
      chunkIndex: 0,
      content: textContent,
      charCount: textContent.length,
      embedding,
    },
  ]);
  console.log("   Indexed 1 chunk into vector store.");

  // 2. Test Grounded Query (Mode A): Binary Search Time Complexity
  console.log("\n2. Testing Grounded Query: 'What is the time complexity of binary search?'");
  const query1 = "What is the time complexity of binary search according to the notes?";
  const plan1 = await orchestrator.orchestrateTurn(
    {
      conversationId: "test-conv",
      content: query1,
      attachments: [{ id: docId, name: filename, size: 1000, mime: "application/pdf" }],
    },
    { hasIndexedDocs: true },
  );

  console.log(`   Answer Mode: ${plan1.answerMode}`);
  console.log(`   Evidence found: ${plan1.retrieval?.hasSufficientEvidence ? "YES" : "NO"}`);
  console.log(`   Citations count: ${plan1.citations.length}`);
  if (plan1.citations.length > 0) {
    console.log(`   Citation 0: ${plan1.citations[0]?.filename} (p. ${plan1.citations[0]?.pageNumber})`);
  }

  if (plan1.answerMode !== "document_grounded") {
    throw new Error(`Expected mode 'document_grounded', got '${plan1.answerMode}'`);
  }
  if (!plan1.retrieval?.hasSufficientEvidence) {
    throw new Error("Expected sufficient evidence for binary search query");
  }
  if (plan1.citations.length === 0) {
    throw new Error("Expected at least one citation for grounded answer");
  }

  // 3. Test Insufficient Evidence Query: Bubble Sort Time Complexity
  console.log("\n3. Testing Insufficient Evidence Query: 'What is the time complexity of bubble sort?'");
  const query2 = "What is the time complexity of bubble sort according to my uploaded document?";
  const plan2 = await orchestrator.orchestrateTurn(
    {
      conversationId: "test-conv",
      content: query2,
      attachments: [{ id: docId, name: filename, size: 1000, mime: "application/pdf" }],
    },
    { hasIndexedDocs: true },
  );

  console.log(`   Answer Mode: ${plan2.answerMode}`);
  console.log(`   Evidence found: ${plan2.retrieval?.hasSufficientEvidence ? "YES" : "NO"}`);
  console.log(`   Direct answer provided: ${plan2.directAnswer ? "YES" : "NO"}`);
  if (plan2.directAnswer) {
    console.log(`   Message snippet: "${plan2.directAnswer.slice(0, 90)}..."`);
  }

  if (plan2.answerMode !== "insufficient_evidence") {
    console.warn(`   Mode returned: ${plan2.answerMode}`);
  }
  if (!plan2.directAnswer || !plan2.directAnswer.includes("couldn't find sufficient supporting information")) {
    throw new Error("Expected insufficient evidence message for bubble sort");
  }

  // 4. Test Private Reasoning Sanitization
  console.log("\n4. Testing Private Reasoning Sanitization (<think> tags)...");
  const testOutputWithThink =
    "<think>\nThe user is asking about algorithms.\nBinary search is O(log n).\n</think>\n" +
    "Binary search has a time complexity of O(log n) as stated in algorithms_study_guide.pdf.";
  const sanitized = sanitizeModelOutput(testOutputWithThink);
  console.log(`   Contains <think>: ${sanitized.includes("<think>")}`);
  console.log(`   Sanitized output: "${sanitized.trim()}"`);

  if (sanitized.includes("<think>") || sanitized.includes("</think>")) {
    throw new Error("<think> tags were not properly stripped");
  }
  if (!sanitized.includes("O(log n)")) {
    throw new Error("Legitimate response content was accidentally removed");
  }

  // Cleanup
  await rm(tempStorePath, { force: true });
  console.log("\n✅ All End-to-End RAG tests passed successfully!\n");
}

run().catch((err) => {
  console.error("❌ E2E RAG Test Failed:", err);
  process.exit(1);
});

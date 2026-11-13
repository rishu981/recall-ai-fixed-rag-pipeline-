/**
 * RAG Pipeline Integration Tests
 *
 * Tests the full document ingestion → chunking → embedding → retrieval → generation pipeline.
 * Run with: npx tsx apps/api/test/rag-pipeline.test.ts
 *
 * Requirements: Ollama must be running with qwen3.5:4b and all-minilm available.
 */

import { createHash, randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { rm } from "fs/promises";

// ─── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: { name: string; ok: boolean; error?: string }[] = [];

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}`);
    console.log(`     ${error}`);
  }
}

// ─── Helpers to build a minimal in-memory PDF buffer ───────────────────────

/**
 * Creates a minimal valid PDF buffer containing the given text.
 * Uses raw PDF syntax — no dependency on pdf-lib for tests.
 */
function buildMinimalPdf(text: string): Buffer {
  const escapedText = text.replace(/[()\\]/g, (c) => `\\${c}`);
  const content = `BT /F1 12 Tf 72 720 Td (${escapedText}) Tj ET`;
  const contentLen = Buffer.byteLength(content, "latin1");

  let xref = "";
  const objects: string[] = [];

  // obj 1: Catalog
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  // obj 2: Pages
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  // obj 3: Page
  const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`;
  // obj 4: Content stream
  const obj4 = `4 0 obj\n<< /Length ${contentLen} >>\nstream\n${content}\nendstream\nendobj\n`;
  // obj 5: Font
  const obj5 = "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

  objects.push(obj1, obj2, obj3, obj4, obj5);

  const header = "%PDF-1.4\n";
  let pos = header.length;
  const offsets: number[] = [];

  for (const obj of objects) {
    offsets.push(pos);
    pos += Buffer.byteLength(obj, "latin1");
  }

  const xrefOffset = pos;
  xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(header + objects.join("") + xref + trailer, "latin1");
}

// ─── Dynamically import RAG modules (they use ESM) ──────────────────────────

const { chunkDocument } = await import("../src/services/rag/chunker.js");
const { generateDeterministicEmbedding, OllamaEmbeddingProvider } = await import(
  "../src/services/rag/embeddings.js"
);
const { PersistentLocalVectorStore } = await import("../src/services/rag/vector-store.js");
const { HybridRetrievalEngine } = await import("../src/services/rag/retrieval.js");
const { DisabledGraphMemoryProvider } = await import("../src/services/graph-memory.js");

// ─── Test vector store in a temp dir ────────────────────────────────────────

const tempStorePath = join(tmpdir(), `rag-test-${randomUUID()}.json`);

// ─── TESTS ──────────────────────────────────────────────────────────────────

console.log("\n🧪 RecallAI RAG Pipeline Tests\n");
console.log("─".repeat(50));

// ── 1. Chunker: basic paragraph splitting ───────────────────────────────────
await test("1. Chunker: splits paragraphs correctly", () => {
  const docId = "test-doc-1";
  const pages = [
    {
      pageNumber: 1,
      text: "Binary search is an efficient algorithm.\n\nIt works on sorted arrays.\n\nThe time complexity is O(log n).",
    },
  ];
  const chunks = chunkDocument(docId, "test.pdf", pages, {
    chunkSize: 200,
    chunkOverlap: 40,
    sha256: "abc123",
  });

  assert(chunks.length > 0, "should produce at least one chunk");
  assert(
    chunks.every((c) => c.documentId === docId),
    "all chunks should have correct documentId",
  );
  assert(
    chunks.every((c) => c.pageNumber === 1),
    "all chunks should have correct pageNumber",
  );
  assert(
    chunks.every((c) => c.filename === "test.pdf"),
    "all chunks should have correct filename",
  );
  assert(
    chunks.every((c) => c.id.startsWith(docId)),
    "chunk IDs should start with documentId",
  );
});

// ── 2. Chunker: metadata preserved ──────────────────────────────────────────
await test("2. Chunker: preserves chunk metadata fields", () => {
  const chunks = chunkDocument(
    "meta-doc",
    "chapter1.pdf",
    [{ pageNumber: 3, text: "The mitochondria is the powerhouse of the cell." }],
    { chunkSize: 200, chunkOverlap: 0 },
    { sha256: "sha256xyz", userId: "u1" },
  );
  assert(chunks.length >= 1, "must produce chunks");
  const c = chunks[0]!;
  assert(c.pageNumber === 3, "page number must be 3");
  assert(c.sha256 === "sha256xyz", "sha256 must match");
  assert(c.userId === "u1", "userId must be preserved");
});

// ── 3. Chunker: empty page produces no chunks ────────────────────────────────
await test("3. Chunker: empty page produces no chunks", () => {
  const chunks = chunkDocument("empty-doc", "blank.pdf", [{ pageNumber: 1, text: "   " }], {
    chunkSize: 200,
    chunkOverlap: 0,
  });
  assert(chunks.length === 0, "empty page should yield no chunks");
});

// ── 4. Chunker: large paragraph splits by sentence ──────────────────────────
await test("4. Chunker: large paragraph splits by sentence", () => {
  const longSentences = Array.from(
    { length: 20 },
    (_, i) => `This is sentence number ${i + 1} in a very long paragraph about biology.`,
  ).join(" ");
  const chunks = chunkDocument(
    "long-doc",
    "long.pdf",
    [{ pageNumber: 1, text: longSentences }],
    { chunkSize: 300, chunkOverlap: 50 },
  );
  assert(chunks.length > 1, "long text must be split into multiple chunks");
  assert(
    chunks.every((c) => c.content.length <= 400),
    "each chunk should not far exceed chunkSize",
  );
});

// ── 5. Deterministic embedding: stable and correct dimensions ─────────────────
await test("5. Embedding: deterministic fallback is stable and 384-dim", () => {
  const emb1 = generateDeterministicEmbedding("hello world");
  const emb2 = generateDeterministicEmbedding("hello world");
  assert(emb1.length === 384, "must be 384 dimensions");
  assert(
    emb1.every((v, i) => v === emb2[i]),
    "same input must produce identical embedding",
  );
  // Check it's normalized
  const norm = Math.sqrt(emb1.reduce((s, v) => s + v * v, 0));
  assert(Math.abs(norm - 1) < 0.001, "embedding should be L2-normalized");
});

// ── 6. Deterministic embedding: different texts differ ────────────────────────
await test("6. Embedding: different texts produce different vectors", () => {
  const e1 = generateDeterministicEmbedding("binary search algorithm");
  const e2 = generateDeterministicEmbedding("photosynthesis in plants");
  const dot = e1.reduce((s, v, i) => s + v * (e2[i] ?? 0), 0);
  assert(dot < 0.98, `very different texts should not be identical (cosine sim=${dot.toFixed(4)})`);
});

// ── 7. Vector store: store and retrieve chunk ─────────────────────────────────
await test("7. Vector store: add and retrieve chunks by documentId", async () => {
  const store = new PersistentLocalVectorStore(tempStorePath);
  await store.init();

  const docId = "vs-test-doc";
  const emb = generateDeterministicEmbedding("binary search is O(log n)");
  await store.upsertChunks([
    {
      id: `${docId}_c0`,
      documentId: docId,
      filename: "binary.pdf",
      pageNumber: 1,
      chunkIndex: 0,
      content: "binary search is O(log n)",
      charCount: 25,
      sha256: "sha-binary",
      embedding: emb,
    },
  ]);

  const docs = await store.listIndexedDocuments();
  assert(
    docs.some((d) => d.documentId === docId),
    "document should appear in listIndexedDocuments",
  );
});

// ── 8. Vector store: persistence across reload ───────────────────────────────
await test("8. Vector store: persists data after reload", async () => {
  const store2 = new PersistentLocalVectorStore(tempStorePath);
  await store2.init();
  const docs = await store2.listIndexedDocuments();
  assert(
    docs.some((d) => d.documentId === "vs-test-doc"),
    "document should survive store reload",
  );
});

// ── 9. Vector store: delete removes all chunks ────────────────────────────────
await test("9. Vector store: delete removes document and its chunks", async () => {
  const store = new PersistentLocalVectorStore(tempStorePath);
  await store.init();
  await store.deleteDocumentChunks("vs-test-doc");
  const docs = await store.listIndexedDocuments();
  assert(
    !docs.some((d) => d.documentId === "vs-test-doc"),
    "deleted document must not appear",
  );
});

// ── 10. Hybrid retrieval: relevant content is found ────────────────────────────
await test("10. Retrieval: finds relevant content by semantic + keyword match", async () => {
  const store = new PersistentLocalVectorStore(tempStorePath);
  await store.init();
  const provider = new OllamaEmbeddingProvider();

  // Index a document about binary search
  const docId = "retrieval-test-doc";
  const text = "The binary search algorithm works on sorted arrays. Its time complexity is O(log n).";
  let embedding: number[];
  try {
    embedding = await provider.embed(text);
  } catch {
    embedding = generateDeterministicEmbedding(text);
  }

  await store.upsertChunks([
    {
      id: `${docId}_c0`,
      documentId: docId,
      filename: "algorithms.pdf",
      pageNumber: 2,
      chunkIndex: 0,
      content: text,
      charCount: text.length,
      sha256: "sha-alg",
      embedding,
    },
  ]);

  const engine = new HybridRetrievalEngine(store, provider);
  const result = await engine.retrieve("What is the time complexity of binary search?", {
    topK: 5,
    minSimilarity: 0.1,
  });

  assert(result.chunks.length > 0, "must find at least one chunk");
  assert(
    result.chunks[0]!.chunk.content.includes("O(log n)"),
    "top chunk should contain 'O(log n)'",
  );
});

// ── 11. Retrieval: irrelevant queries return empty / low-score results ─────────
await test("11. Retrieval: irrelevant query returns empty with high threshold", async () => {
  const store = new PersistentLocalVectorStore(tempStorePath);
  await store.init();
  const provider = new OllamaEmbeddingProvider();
  const engine = new HybridRetrievalEngine(store, provider);

  // Query about bubble sort when only binary search is indexed
  const result = await engine.retrieve("What is the time complexity of bubble sort?", {
    topK: 5,
    minSimilarity: 0.75, // high threshold → should return nothing
  });

  // With a very high threshold, bubble sort query should not match binary search content
  assert(
    result.chunks.length === 0 || (result.chunks[0]?.similarity ?? 0) < 0.75,
    "irrelevant query should not pass high similarity threshold",
  );
});

// ── 12. Graph memory: DisabledProvider is a no-op ─────────────────────────────
await test("12. FalkorDB: DisabledGraphMemoryProvider is gracefully no-op", async () => {
  const disabled = new DisabledGraphMemoryProvider();
  assert(disabled.isConnected === false, "should report disconnected");
  const memories = await disabled.retrieveMemories("any query");
  assert(memories.items.length === 0, "must return empty items");
  const stored = await disabled.storeMemory({ id: "x", type: "concept", label: "X", summary: "X" } as any);
  assert(stored === false, "storeMemory must return false");
  const health = await disabled.healthCheck();
  assert(health.ok === true, "health check must still be ok");
  assert(health.connected === false, "connected must be false");
});

// ── 13. Chunker: chunk index is monotonically increasing ──────────────────────
await test("13. Chunker: chunk indices are unique and monotonically increasing", () => {
  const pages = [
    { pageNumber: 1, text: "Alpha content on page one.\n\nBeta content on page one." },
    { pageNumber: 2, text: "Gamma content on page two.\n\nDelta content on page two." },
  ];
  const chunks = chunkDocument("index-doc", "multi.pdf", pages, {
    chunkSize: 100,
    chunkOverlap: 10,
  });

  const indices = chunks.map((c) => c.chunkIndex);
  for (let i = 1; i < indices.length; i++) {
    assert(indices[i]! > indices[i - 1]!, `chunk index ${i} must be greater than ${i - 1}`);
  }
});

// ── 14. Vector store: listDocuments returns correct summary ────────────────────
await test("14. Vector store: listDocuments returns accurate summary", async () => {
  const store = new PersistentLocalVectorStore(tempStorePath);
  await store.init();

  const docId = "summary-test-doc";
  const emb = generateDeterministicEmbedding("photosynthesis in plants");
  await store.upsertChunks([
    {
      id: `${docId}_c0`,
      documentId: docId,
      filename: "biology.pdf",
      pageNumber: 1,
      chunkIndex: 0,
      content: "Photosynthesis is the process by which plants make food.",
      charCount: 55,
      sha256: "sha-bio",
      embedding: emb,
    },
    {
      id: `${docId}_c1`,
      documentId: docId,
      filename: "biology.pdf",
      pageNumber: 1,
      chunkIndex: 1,
      content: "Chlorophyll absorbs sunlight for photosynthesis.",
      charCount: 48,
      sha256: "sha-bio",
      embedding: emb,
    },
  ]);

  const docs = await store.listIndexedDocuments();
  const doc = docs.find((d) => d.documentId === docId);
  assert(doc !== undefined, "document must appear in listIndexedDocuments");
  assert(doc!.chunkCount === 2, `chunkCount should be 2, got ${doc!.chunkCount}`);
  assert(doc!.filename === "biology.pdf", "filename should match");
});

// ── 15. Embedding fallback: works without Ollama ──────────────────────────────
await test("15. Embedding: deterministic fallback handles empty text", () => {
  const emb = generateDeterministicEmbedding("");
  assert(emb.length === 384, "must still be 384-dim for empty text");
  // All zeros are fine for empty text (no normalization needed)
});

// ── 16. Chunker: overlap text carries context forward ─────────────────────────
await test("16. Chunker: overlap carries content between adjacent chunks", () => {
  const longText = Array.from({ length: 15 }, (_, i) =>
    `Sentence ${i + 1} about biology and cellular respiration processes.`,
  ).join(" ");
  const chunks = chunkDocument("overlap-doc", "overlap.pdf", [{ pageNumber: 1, text: longText }], {
    chunkSize: 250,
    chunkOverlap: 60,
  });
  if (chunks.length >= 2) {
    // Verify overlap: the beginning of chunk[1] should share words with the end of chunk[0]
    const endOfFirst = chunks[0]!.content.slice(-40).toLowerCase();
    const startOfSecond = chunks[1]!.content.slice(0, 80).toLowerCase();
    const firstWords = endOfFirst.split(/\s+/).filter(Boolean);
    const secondText = startOfSecond;
    const overlapping = firstWords.some((w) => w.length > 3 && secondText.includes(w));
    assert(overlapping, "overlap should carry some words from previous chunk into next");
  }
  // If only 1 chunk, the text was short enough — that's OK
  assert(chunks.length >= 1, "must have at least one chunk");
});

// ── 17. Retrieval engine: empty store returns empty result ─────────────────────
await test("17. Retrieval: empty vector store returns empty result", async () => {
  const emptyStorePath = join(tmpdir(), `rag-empty-${randomUUID()}.json`);
  const store = new PersistentLocalVectorStore(emptyStorePath);
  await store.init();
  const provider = new OllamaEmbeddingProvider();
  const engine = new HybridRetrievalEngine(store, provider);
  const result = await engine.retrieve("any question", { topK: 5 });
  assert(result.chunks.length === 0, "empty store must return no chunks");
  await rm(emptyStorePath, { force: true });
});

// ── 18. Cleanup: temp store can be deleted ────────────────────────────────────
await test("18. Cleanup: temp store file can be removed", async () => {
  await rm(tempStorePath, { force: true });
  // No error = pass
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log("\n" + "─".repeat(50));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

if (failed > 0) {
  console.log("Failed tests:");
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  ❌ ${r.name}`);
    console.log(`     ${r.error}`);
  }
  process.exit(1);
} else {
  console.log("✅ All RAG pipeline tests passed!\n");
  process.exit(0);
}

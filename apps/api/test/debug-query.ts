import { defaultVectorStore } from "../src/services/rag/vector-store.js";
import { defaultRetrievalEngine } from "../src/services/rag/retrieval.js";

async function main() {
  await defaultVectorStore.init();

  const testQueries = [
    "summarize this",
    "what is this document about",
    "what is SafeScript AI",
    "explain this proposal",
    "what are the key points",
    "tell me about this document",
    "what is SafeScript AI Technical Proposal",
    "what is the time complexity of bubble sort",
  ];

  for (const q of testQueries) {
    const res = await defaultRetrievalEngine.retrieve(q, {
      documentIds: ["87f09544-f82b-43d0-aa8a-ecdb71150c5e"],
    });
    console.log(`\nQuery: "${q}"`);
    console.log(`  hasSufficientEvidence: ${res.hasSufficientEvidence}`);
    console.log(`  retrievalMode: ${res.retrievalMode}`);
    console.log(`  insufficientReason: ${res.insufficientReason ?? "none"}`);
    console.log(`  chunks found: ${res.chunks.length}`);
    if (res.chunks.length > 0) {
      console.log(`  top similarity: ${res.chunks[0]?.similarity.toFixed(4)}, keyword: ${res.chunks[0]?.keywordScore?.toFixed(4)}, hybrid: ${res.chunks[0]?.hybridScore?.toFixed(4)}`);
      console.log(`  top snippet: "${res.chunks[0]?.chunk.content.slice(0, 120)}..."`);
    }
  }
}

main().catch(console.error);

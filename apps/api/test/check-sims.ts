import { defaultVectorStore, cosineSimilarity } from "../src/services/rag/vector-store.js";
import { defaultEmbeddingProvider } from "../src/services/rag/embeddings.js";

async function run() {
  await defaultVectorStore.init();
  const safeScriptDoc = "87f09544-f82b-43d0-aa8a-ecdb71150c5e";
  const chunks = await defaultVectorStore.getChunksForDocument(safeScriptDoc);
  console.log(`Loaded ${chunks.length} chunks for SafeScript.`);

  const queries = [
    "summarize this",
    "summarize",
    "what is this",
    "overview",
    "key points",
    "what is SafeScript AI",
    "SafeScript AI",
    "proposal",
  ];

  for (const q of queries) {
    const qEmb = await defaultEmbeddingProvider.embed(q);
    const sims = chunks.map((c) => ({
      sim: cosineSimilarity(qEmb, c.embedding),
      content: c.content.slice(0, 70),
    }));
    sims.sort((a, b) => b.sim - a.sim);
    console.log(`\nQuery: "${q}"`);
    for (let i = 0; i < 3; i++) {
      console.log(`  top ${i + 1}: sim=${sims[i]?.sim.toFixed(4)} -> "${sims[i]?.content}..."`);
    }
  }
}

run().catch(console.error);


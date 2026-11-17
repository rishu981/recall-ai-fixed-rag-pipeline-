import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  console.log("Testing live HTTP upload to http://localhost:4000/api/uploads...");

  // Create a 1.5 MB textbook chapter
  const testFile = join(tmpdir(), "textbook_linear_algebra_chapter.txt");
  const section = "Section 4.2: Vector Spaces, Subspaces, and Orthogonality.\nA subset W of a vector space V is a subspace if it contains the zero vector and is closed under addition and scalar multiplication.\nEigenvectors corresponding to distinct eigenvalues are linearly independent.\n\n";
  const data = section.repeat(6000); // ~1.5 MB
  writeFileSync(testFile, data, "utf8");

  try {
    const fileBlob = new Blob([data], { type: "text/plain" });
    const form = new FormData();
    form.append("file", fileBlob, "textbook_linear_algebra_chapter.txt");

    const startTime = Date.now();
    const res = await fetch("http://localhost:4000/api/uploads", {
      method: "POST",
      headers: {
        "x-user-id": "test_student",
      },
      body: form,
    });

    const elapsed = Date.now() - startTime;
    console.log(`Upload HTTP Status: ${res.status} (in ${(elapsed / 1000).toFixed(1)}s)`);
    const json = (await res.json()) as any;
    console.log("Upload Response:", {
      id: json.id,
      name: json.name,
      size: `${(json.size / 1024 / 1024).toFixed(2)} MB`,
      status: json.status,
      chunkCount: json.chunkCount,
      indexed: json.indexed,
    });

    if (res.status === 201 && json.status === "ready") {
      console.log("\n✅ Large textbook upload (>1MB) succeeded and indexed in vector store!");
    } else {
      console.error("\n❌ Upload failed:", json);
      process.exit(1);
    }
  } finally {
    try {
      unlinkSync(testFile);
    } catch {}
  }
}

main().catch(console.error);

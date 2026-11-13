import { Blob } from "buffer";

async function testFlow() {
  // 1. Create a minimal PDF buffer
  const text = "The binary search algorithm has time complexity O(log n). It requires a sorted array.";
  const escapedText = text.replace(/[()\\]/g, (c) => "\\" + c);
  const content = `BT /F1 12 Tf 72 720 Td (${escapedText}) Tj ET`;
  const contentLen = Buffer.byteLength(content, "latin1");
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 = "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
  const obj4 = `4 0 obj\n<< /Length ${contentLen} >>\nstream\n${content}\nendstream\nendobj\n`;
  const obj5 = "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  const objects = [obj1, obj2, obj3, obj4, obj5];
  const header = "%PDF-1.4\n";
  let pos = header.length;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pos);
    pos += Buffer.byteLength(obj, "latin1");
  }
  const xrefOffset = pos;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (const off of offsets) {
    xref += String(off).padStart(10, "0") + " 00000 n \n";
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const pdfBuf = Buffer.from(header + objects.join("") + xref + trailer, "latin1");

  // 2. Upload via multipart/form-data
  const form = new FormData();
  form.append("file", new Blob([pdfBuf], { type: "application/pdf" }), "binary_search_guide.pdf");

  console.log("1. Uploading PDF to /api/uploads...");
  const uploadRes = await fetch("http://localhost:4000/api/uploads", {
    method: "POST",
    body: form,
    headers: { "x-user-id": "test_student" },
  });
  const uploadData = (await uploadRes.json()) as any;
  console.log("   Uploaded:", uploadData.id, uploadData.name, `(${uploadData.chunkCount} chunks)`);

  // 3. Create conversation
  console.log("2. Creating conversation...");
  const convRes = await fetch("http://localhost:4000/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-id": "test_student" },
    body: JSON.stringify({ title: "Binary Search Study" }),
  });
  const conv = (await convRes.json()) as any;
  console.log("   Created conversation:", conv.id);

  // 4. Send query via stream
  console.log("3. Sending query via SSE stream...");
  const streamRes = await fetch(
    `http://localhost:4000/api/conversations/${conv.id}/messages/stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": "test_student",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        content: "What is the time complexity of binary search according to the uploaded notes?",
        attachmentIds: [uploadData.id],
      }),
    },
  );

  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let fullAnswer = "";
  let citationsEvent: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === "delta") fullAnswer += ev.text;
          if (ev.type === "citations") citationsEvent = ev;
        } catch {}
      }
    }
  }

  console.log("\n--- MODEL RESPONSE ---");
  console.log(fullAnswer.trim());
  console.log("----------------------");
  console.log("Citations:", JSON.stringify(citationsEvent, null, 2));

  // Assertions
  if (!fullAnswer.toLowerCase().includes("log n") && !fullAnswer.toLowerCase().includes("log(n)")) {
    throw new Error("Answer did not mention O(log n)");
  }
  if (fullAnswer.includes("<think>")) {
    throw new Error("<think> tags leaked into output!");
  }
  if (!citationsEvent || citationsEvent.citations?.length === 0) {
    throw new Error("No citations were emitted in the stream!");
  }
  console.log("\n✅ End-to-end HTTP streaming test passed successfully!\n");
}

testFlow().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});

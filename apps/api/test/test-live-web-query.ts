async function main() {
  console.log("Testing live streaming HTTP query with internet access enabled...\n");

  const convRes = await fetch("http://localhost:4000/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const conv = await convRes.json();
  const convId = conv.id;
  console.log(`Created conversation: ${convId}`);

  console.log("Sending query with webSearch: false (Toggle OFF)...");
  const streamResOff = await fetch(`http://localhost:4000/api/conversations/${convId}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "Explain Newton's third law of motion.",
      responseMode: "study",
      webSearch: false,
    }),
  });

  const readerOff = streamResOff.body?.getReader();
  if (readerOff) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await readerOff.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "citations") {
              console.log(`[Toggle OFF Citations] Count: ${ev.citations?.length || 0}, Mode: ${ev.answerMode}`);
            }
          } catch {}
        }
      }
    }
  }

  console.log("\nSending query with webSearch: true (Toggle ON)...");
  const streamRes = await fetch(`http://localhost:4000/api/conversations/${convId}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "What is the theory of general relativity according to Wikipedia? Explain briefly.",
      responseMode: "study",
      webSearch: true,
    }),
  });

  const reader = streamRes.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullAnswer = "";
  let receivedCitations: any[] = [];
  let answerMode = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "citations") {
            receivedCitations = event.citations || [];
            answerMode = event.answerMode || "";
            console.log(`[Event: Citations] Mode: ${answerMode}, Citations: ${receivedCitations.length}`);
            for (const c of receivedCitations) {
              console.log(`  - ${c.filename} (${c.url})`);
            }
          } else if (event.type === "delta") {
            fullAnswer += event.text;
          }
        } catch {}
      }
    }
  }

  console.log("\n--- Generated Answer from Qwen ---");
  console.log(fullAnswer);
  console.log("----------------------------------");

  if (receivedCitations.length > 0 && answerMode === "web_grounded") {
    console.log("\n✅ SUCCESS: Model successfully searched the internet, grounded its answer, and generated web citations!");
  } else {
    console.log(`\nMode was ${answerMode}, citations count: ${receivedCitations.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

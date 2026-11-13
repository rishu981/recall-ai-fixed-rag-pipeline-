async function main() {
  const safeScriptDocId = "87f09544-f82b-43d0-aa8a-ecdb71150c5e";

  console.log("Creating conversation for empty content test...");
  const convRes = await fetch("http://localhost:4000/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-id": "test_student" },
    body: JSON.stringify({ title: "Empty Prompt Upload Test" }),
  });
  const conv = (await convRes.json()) as any;

  console.log("Sending query with content: '' (empty string) and attachmentIds...");
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
        content: "",
        attachmentIds: [safeScriptDocId],
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
    for (const line of chunk.split("\n")) {
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

  console.log("\n--- MODEL RESPONSE (EMPTY CONTENT) ---");
  console.log(fullAnswer.trim().slice(0, 300) + "...");
  console.log("--------------------------------------");
  console.log("Answer Mode:", citationsEvent?.answerMode);
  console.log("Citations count:", citationsEvent?.citations?.length);
  if (citationsEvent?.citations?.length > 0) {
    console.log("First citation:", citationsEvent.citations[0].filename, "Page", citationsEvent.citations[0].pageNumber);
  }
}

main().catch(console.error);


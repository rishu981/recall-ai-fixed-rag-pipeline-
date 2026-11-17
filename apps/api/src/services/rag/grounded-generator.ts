import type { Citation, AnswerMode } from "@recallai/shared-types";
import type { RetrievalResult, VectorSearchResult } from "./types.js";

/**
 * Builds the strict grounded system prompt for Mode A (Document-Grounded).
 */
export function buildGroundedPrompt(
  retrieval: RetrievalResult,
  userPrompt: string,
  responseMode: "study" | "deep-dive" | "quiz" = "study",
): { systemPrompt: string; userMessage: string } {
  let contextSection = "";

  for (let i = 0; i < retrieval.chunks.length; i++) {
    const item = retrieval.chunks[i]!;
    const c = item.chunk;
    contextSection += `[EXCERPT ${i + 1}] (Document: "${c.filename}", Page: ${c.pageNumber})\n${c.content}\n\n`;
  }

  const systemPrompt = [
    `You are RecallAI, a rigorous, evidence-grounded academic study assistant.`,
    `You are operating in DOCUMENT-GROUNDED MODE (Mode A).`,
    ``,
    `### STRICT EVIDENCE-FIRST GUIDELINES:`,
    `1. Answer the student's question based EXCLUSIVELY on the provided document excerpts below.`,
    `2. Cite the exact source file and page for every factual assertion using this format: [Source: <filename>, Page <pageNumber>].`,
    `3. Never fabricate or extrapolate facts, definitions, formulas, or conclusions not directly supported by the text.`,
    `4. If the provided excerpts do not contain the answer, you MUST state explicitly:`,
    `   "I couldn't find sufficient supporting information in your uploaded materials to answer that reliably."`,
    `   Do NOT manufacture an answer.`,
    `5. For mathematics or science formulas, use standard LaTeX / KaTeX ($...$ inline, $$...$$ block).`,
    `6. PRIVATE REASONING: NEVER output internal thinking tokens, <think> tags, or reasoning traces. Output only the clean, final academic answer.`,
    ``,
    `### VERIFIED RETRIEVED EXCERPTS:`,
    contextSection.trim(),
  ].join("\n");

  let modeInstruction = "";
  if (responseMode === "quiz") {
    modeInstruction = "\nFormulate diagnostic quiz questions based directly on the facts in these excerpts.";
  } else if (responseMode === "deep-dive") {
    modeInstruction = "\nProvide a detailed, exhaustive breakdown strictly based on these excerpts.";
  }

  const userMessage = `${userPrompt.trim()}${modeInstruction}`;

  return { systemPrompt, userMessage };
}

/**
 * Builds the standard General Knowledge prompt for Mode B.
 */
export function buildGeneralKnowledgePrompt(
  userPrompt: string,
  responseMode: "study" | "deep-dive" | "quiz" = "study",
  historyContext = "",
  webSearchActive = false,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt = [
    `You are RecallAI, an expert, rigorous, and encouraging academic tutor.`,
    `You are operating in GENERAL KNOWLEDGE MODE (Mode B). The student has asked a general academic question.`,
    ``,
    `### TEMPORAL CONTEXT:`,
    `- Current Real-World Year: 2026.`,
    webSearchActive
      ? `- The student has turned ON Web Search. Live search is active and accessible.`
      : `- Today is 2026. If asked about the current year or recent events, never claim your knowledge is frozen in 2024.`,
    `- ABSOLUTE PROHIBITION: NEVER claim or state that you cannot access the internet, browse the web, or that your knowledge ends in 2024.`,
    ``,
    `### Guidelines:`,
    `- Use your academic knowledge to provide an insightful, pedagogical explanation.`,
    `- Structure responses clearly: physical/intuitive mental model first, formal principle second, common mistake/cognitive trap third.`,
    `- Use standard LaTeX / KaTeX for all formulas ($...$ inline, $$...$$ display).`,
    `- Do NOT fabricate citations or falsely attribute general knowledge to any uploaded documents.`,
    `- PRIVATE REASONING: NEVER output internal thinking tokens, <think> tags, or reasoning traces. Output only the clean academic answer.`,
    historyContext ? `\n### Student Context:\n${historyContext}` : "",
  ].join("\n");

  return { systemPrompt, userMessage: userPrompt.trim() };
}

/**
 * Builds the Web-Grounded prompt using external live search findings.
 */
export function buildWebGroundedPrompt(
  userPrompt: string,
  webResults: Array<{ title: string; url: string; snippet: string; content?: string }>,
  responseMode: "study" | "deep-dive" | "quiz" = "study",
): { systemPrompt: string; userMessage: string } {
  let contextSection = "";
  for (let i = 0; i < webResults.length; i++) {
    const r = webResults[i]!;
    const bodyText = r.content ? r.content.slice(0, 2000) : r.snippet;
    contextSection += `[WEB SOURCE ${i + 1}] Title: "${r.title}"\nURL: ${r.url}\nSummary:\n${bodyText}\n\n`;
  }

  const systemPrompt = [
    `You are RecallAI, an expert, rigorous academic research and study assistant.`,
    `You are operating in LIVE WEB-GROUNDED RESEARCH MODE. The student has turned ON Web Search.`,
    ``,
    `### TEMPORAL CONTEXT & LIVE INTERNET ACCESS NOTICE:`,
    `- CURRENT YEAR: 2026. Real-time internet access is ACTIVATED.`,
    `- You have live web search capabilities enabled via RecallAI's Web Search RAG pipeline.`,
    `- ABSOLUTE DIRECTIVE: NEVER claim that you do not have internet access, cannot browse the web, or that your knowledge is cut off in 2024. You are looking directly at real-time 2026 web search findings below.`,
    `- Ground your answers directly in the fresh verified web findings provided below.`,
    ``,
    `### GUIDELINES:`,
    `1. Answer the student's question accurately, grounded in the retrieved web sources below.`,
    `2. When citing facts, include the source title and link using this Markdown format: [Source: <Title>](<URL>).`,
    `3. Synthesize the key points logically: explain the concept, provide practical details/examples, and highlight takeaways.`,
    `4. For formulas or technical notations, use standard LaTeX / KaTeX ($...$ inline, $$...$$ block).`,
    `5. PRIVATE REASONING: NEVER output internal thinking tokens, <think> tags, or reasoning traces. Output only the final, clean answer.`,
    ``,
    `### VERIFIED LIVE WEB FINDINGS:`,
    contextSection.trim(),
  ].join("\n");

  let modeInstruction = "";
  if (responseMode === "quiz") {
    modeInstruction = "\nFormulate diagnostic quiz questions based directly on these web research findings.";
  } else if (responseMode === "deep-dive") {
    modeInstruction = "\nProvide a comprehensive, in-depth breakdown covering principles, nuances, and real-world applications.";
  }

  const userMessage = `${userPrompt.trim()}${modeInstruction}`;
  return { systemPrompt, userMessage };
}

/**
 * Builds the Hybrid prompt synthesizing both uploaded textbook/document excerpts and live web findings.
 */
export function buildHybridPrompt(
  userPrompt: string,
  retrieval: RetrievalResult,
  webResults: Array<{ title: string; url: string; snippet: string; content?: string }>,
  responseMode: "study" | "deep-dive" | "quiz" = "study",
): { systemPrompt: string; userMessage: string } {
  let docSection = "";
  for (let i = 0; i < retrieval.chunks.length; i++) {
    const item = retrieval.chunks[i]!;
    const c = item.chunk;
    docSection += `[COURSE MATERIAL ${i + 1}] (Document: "${c.filename}", Page: ${c.pageNumber})\n${c.content}\n\n`;
  }

  let webSection = "";
  for (let i = 0; i < webResults.length; i++) {
    const r = webResults[i]!;
    const bodyText = r.content ? r.content.slice(0, 1200) : r.snippet;
    webSection += `[WEB RESEARCH ${i + 1}] Title: "${r.title}"\nURL: ${r.url}\nSummary:\n${bodyText}\n\n`;
  }

  const systemPrompt = [
    `You are RecallAI, an expert academic assistant operating in HYBRID STUDY MODE.`,
    `You have access to both the student's uploaded course materials and live external web research.`,
    ``,
    `### GUIDELINES:`,
    `1. Synthesize their course materials with external web research to give a complete, grounded answer.`,
    `2. Clearly differentiate your citations:`,
    `   - For their uploaded materials: cite [Source: <filename>, Page <pageNumber>].`,
    `   - For web research: cite [Source: <Title>](<URL>).`,
    `3. Highlight how the web research enriches or clarifies their course notes.`,
    `4. Use standard LaTeX / KaTeX for mathematical and scientific notation.`,
    `5. PRIVATE REASONING: NEVER output internal thinking tokens, <think> tags, or reasoning traces. Output only the clean academic answer.`,
    ``,
    `### STUDENT COURSE MATERIALS:`,
    docSection.trim(),
    ``,
    `### EXTERNAL WEB RESEARCH:`,
    webSection.trim(),
  ].join("\n");

  const userMessage = userPrompt.trim();
  return { systemPrompt, userMessage };
}

/**
 * Standard message when evidence is insufficient in uploaded documents.
 */
export const INSUFFICIENT_EVIDENCE_MESSAGE =
  "I couldn't find sufficient supporting information in your uploaded materials to answer that reliably.\n\n" +
  "You can:\n" +
  "- Upload or attach the specific notes or chapter covering this topic.\n" +
  "- Ask me to explain it using general academic knowledge.";

/**
 * Sanitizes model generation outputs to prevent leaking internal reasoning traces,
 * <think>...</think> blocks, or malformed tags (satisfies Section 6).
 */
export function sanitizeModelOutput(text: string): string {
  if (!text) return "";

  let cleaned = text
    // Strip <think>...</think> blocks completely
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // Strip unclosed <think> blocks
    .replace(/<think>[\s\S]*/gi, "")
    // Strip common scratchpad prefixes
    .replace(/^Thinking Process:[\s\S]*?(?=\n\n|\n[A-Z#])/i, "")
    // Clean up excessive whitespace
    .trim();

  return cleaned;
}


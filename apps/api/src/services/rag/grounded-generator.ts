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
): { systemPrompt: string; userMessage: string } {
  const systemPrompt = [
    `You are RecallAI, an expert, rigorous, and encouraging academic tutor.`,
    `You are operating in GENERAL KNOWLEDGE MODE (Mode B). The student has asked a general academic question.`,
    ``,
    `### Guidelines:`,
    `- Use your general academic knowledge to provide an insightful, pedagogical explanation.`,
    `- Structure responses clearly: physical/intuitive mental model first, formal principle second, common mistake/cognitive trap third.`,
    `- Use standard LaTeX / KaTeX for all formulas ($...$ inline, $$...$$ display).`,
    `- Do NOT fabricate citations or falsely attribute general knowledge to any uploaded documents.`,
    `- PRIVATE REASONING: NEVER output internal thinking tokens, <think> tags, or reasoning traces. Output only the clean academic answer.`,
    historyContext ? `\n### Student Context:\n${historyContext}` : "",
  ].join("\n");

  return { systemPrompt, userMessage: userPrompt.trim() };
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


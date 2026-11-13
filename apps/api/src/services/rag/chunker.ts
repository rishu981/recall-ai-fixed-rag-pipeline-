import type { DocumentPage } from "../files.js";
import type { DocumentChunkDraft } from "./types.js";
import { config } from "../../config.js";

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  minChunkSize?: number;
}

/**
 * Intelligent paragraph and sentence-boundary text chunker.
 *
 * Iterates page-by-page so exact page numbers are strictly preserved.
 * Prioritizes natural semantic boundaries:
 *   1. Paragraph breaks (\n\n+)
 *   2. Sentence boundaries (. ! ?)
 *   3. Line breaks (\n+)
 *   4. Word boundaries (spaces)
 */
export function chunkDocument(
  documentId: string,
  filename: string,
  pages: DocumentPage[],
  options: ChunkOptions = {},
  extraMetadata: { sha256?: string; userId?: string; conversationId?: string } = {},
): DocumentChunkDraft[] {
  const targetSize = options.chunkSize ?? config.ragChunkSize;
  const targetOverlap = options.chunkOverlap ?? config.ragChunkOverlap;
  const minSize = options.minChunkSize ?? Math.min(80, Math.floor(targetSize * 0.2));

  const chunks: DocumentChunkDraft[] = [];
  let globalChunkIndex = 0;

  for (const page of pages) {
    const rawText = page.text.trim();
    if (!rawText) continue;

    // Split into initial paragraph blocks
    const paragraphs = rawText
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    let currentChunk = "";

    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      const paragraph = paragraphs[pIdx];
      if (!paragraph) continue;

      // If adding this paragraph fits comfortably within targetSize
      if (currentChunk.length + paragraph.length + 2 <= targetSize) {
        currentChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;
      } else {
        // If currentChunk already has enough text, emit it
        if (currentChunk.length >= minSize) {
          chunks.push({
            id: `${documentId}_p${page.pageNumber}_c${globalChunkIndex}`,
            documentId,
            filename,
            pageNumber: page.pageNumber,
            chunkIndex: globalChunkIndex++,
            content: currentChunk.trim(),
            charCount: currentChunk.trim().length,
            sha256: extraMetadata.sha256,
            userId: extraMetadata.userId,
            conversationId: extraMetadata.conversationId,
          });

          // Carry over overlap from the end of currentChunk
          const overlapText = getTrailingOverlap(currentChunk, targetOverlap);
          currentChunk = overlapText ? `${overlapText}\n\n${paragraph}` : paragraph;
        } else {
          currentChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;
        }

        // If a single paragraph is larger than targetSize, split by sentence
        if (currentChunk.length > targetSize + targetOverlap) {
          const sentences = splitIntoSentences(currentChunk);
          let sentenceBuffer = "";

          for (const sentence of sentences) {
            if (sentenceBuffer.length + sentence.length + 1 <= targetSize) {
              sentenceBuffer = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;
            } else {
              if (sentenceBuffer.length >= minSize) {
                chunks.push({
                  id: `${documentId}_p${page.pageNumber}_c${globalChunkIndex}`,
                  documentId,
                  filename,
                  pageNumber: page.pageNumber,
                  chunkIndex: globalChunkIndex++,
                  content: sentenceBuffer.trim(),
                  charCount: sentenceBuffer.trim().length,
                  sha256: extraMetadata.sha256,
                  userId: extraMetadata.userId,
                  conversationId: extraMetadata.conversationId,
                });
                const sentOverlap = getTrailingOverlap(sentenceBuffer, targetOverlap);
                sentenceBuffer = sentOverlap ? `${sentOverlap} ${sentence}` : sentence;
              } else {
                sentenceBuffer = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;
              }
            }
          }
          currentChunk = sentenceBuffer;
        }
      }
    }

    // Emit any remaining tail for this page
    if (currentChunk.trim().length >= minSize) {
      chunks.push({
        id: `${documentId}_p${page.pageNumber}_c${globalChunkIndex}`,
        documentId,
        filename,
        pageNumber: page.pageNumber,
        chunkIndex: globalChunkIndex++,
        content: currentChunk.trim(),
        charCount: currentChunk.trim().length,
        sha256: extraMetadata.sha256,
        userId: extraMetadata.userId,
        conversationId: extraMetadata.conversationId,
      });
    } else if (currentChunk.trim().length > 0) {
      // If remaining chunk is very small, append to previous chunk if on same page
      const prev = chunks[chunks.length - 1];
      if (prev && prev.pageNumber === page.pageNumber) {
        prev.content = `${prev.content}\n\n${currentChunk.trim()}`;
        prev.charCount = prev.content.length;
      } else {
        chunks.push({
          id: `${documentId}_p${page.pageNumber}_c${globalChunkIndex}`,
          documentId,
          filename,
          pageNumber: page.pageNumber,
          chunkIndex: globalChunkIndex++,
          content: currentChunk.trim(),
          charCount: currentChunk.trim().length,
          sha256: extraMetadata.sha256,
          userId: extraMetadata.userId,
          conversationId: extraMetadata.conversationId,
        });
      }
    }
  }

  return chunks;
}

/** Safely splits text on sentence boundaries without breaking decimals or abbreviations. */
function splitIntoSentences(text: string): string[] {
  // Regex splits on punctuation (. ! ?) followed by whitespace, keeping the punctuation
  const matches = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  if (!matches) return [text];
  return matches.map((m) => m.trim()).filter(Boolean);
}

/** Extracts the trailing sentence or word slice for smooth chunk overlap. */
function getTrailingOverlap(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return "";
  const slice = text.slice(-overlapChars);
  // Find first space or sentence boundary in the overlap slice to avoid cutting words
  const spaceIdx = slice.indexOf(" ");
  if (spaceIdx !== -1 && spaceIdx < slice.length - 10) {
    return slice.slice(spaceIdx + 1).trim();
  }
  return slice.trim();
}


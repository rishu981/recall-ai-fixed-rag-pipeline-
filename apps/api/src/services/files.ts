import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { PDFParse } from "pdf-parse";

/**
 * File handling & document extraction.
 *
 * Rules:
 *  - uploads are untrusted input; nothing executes or interprets content
 *  - server-side validation is enforced
 *  - page numbers are extracted and preserved for exact RAG citations
 *  - scanned/empty PDFs are detected and clearly reported (OCR required)
 */
export interface StoredFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface DocumentPage {
  pageNumber: number;
  text: string;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function saveFile(
  dir: string,
  originalName: string,
  buffer: Buffer,
): Promise<StoredFile> {
  await ensureDir(dir);
  const safeExt = extname(originalName).toLowerCase().slice(0, 12);
  const stored = `${randomUUID()}${safeExt}`;
  const full = join(dir, stored);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  await writeFile(full, buffer);
  return { path: full, bytes: buffer.byteLength, sha256 };
}

export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* already gone */
  }
}

export type ExtractionResult =
  | {
      ok: true;
      text: string;
      chars: number;
      pages: DocumentPage[];
      pageCount: number;
      sha256: string;
    }
  | {
      ok: false;
      reason: string;
      isScannedOrEmpty?: boolean;
    };

/** Extracts text from a stored file preserving page boundaries, or explains why it could not. */
export async function extractText(
  filePath: string,
  mimeType: string,
): Promise<ExtractionResult> {
  const isText = mimeType.startsWith("text/") || /\.(txt|md|csv|json)$/i.test(filePath);

  if (isText) {
    try {
      const buffer = await readFile(filePath);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const raw = buffer.toString("utf8");
      // Strip control characters; keep content intact
      const text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();

      if (!text) {
        return {
          ok: false,
          reason: "The uploaded text document contains no readable text.",
          isScannedOrEmpty: true,
        };
      }

      return {
        ok: true,
        text,
        chars: text.length,
        pages: [{ pageNumber: 1, text }],
        pageCount: 1,
        sha256,
      };
    } catch (err) {
      return { ok: false, reason: `Could not read the file: ${String(err)}` };
    }
  }

  if (mimeType === "application/pdf" || /\.pdf$/i.test(filePath)) {
    try {
      const buffer = await readFile(filePath);
      const sha256 = createHash("sha256").update(buffer).digest("hex");

      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();

      const rawPages = parsed.pages ?? [];
      const pages: DocumentPage[] = rawPages
        .map((p) => ({
          pageNumber: p.num,
          text: (p.text ?? "")
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
            .replace(/--\s*\d+\s*of\s*\d+\s*--/g, "")
            .trim(),
        }))
        .filter((p) => p.text.length > 0);

      const fullText = pages.map((p) => p.text).join("\n\n").trim();
      const chars = fullText.length;

      if (chars === 0) {
        return {
          ok: false,
          reason: "No extractable text was found in this PDF. It may be a scanned image or empty and requires OCR.",
          isScannedOrEmpty: true,
        };
      }

      return {
        ok: true,
        text: fullText,
        chars,
        pages,
        pageCount: parsed.total || pages.length || 1,
        sha256,
      };
    } catch (err) {
      return {
        ok: false,
        reason: `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (mimeType.startsWith("image/")) {
    return {
      ok: false,
      reason: "Image text extraction needs OCR, which is not wired up yet.",
    };
  }

  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return {
      ok: false,
      reason: "DOCX text extraction is not wired up yet.",
    };
  }

  return { ok: false, reason: `No extractor for ${mimeType || "this file type"}.` };
}

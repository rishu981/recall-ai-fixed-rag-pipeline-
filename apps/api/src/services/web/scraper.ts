/**
 * Lightweight, zero-dependency HTML article extractor and cleaner.
 * Strips boilerplate, navigation, scripts, styles, and decodes HTML entities.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function htmlToCleanText(html: string): string {
  if (!html) return "";

  // 1. Remove binary/media/script/style/nav/header/footer tags completely
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ")
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, " ")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, " ")
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, " ")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // 2. Add line breaks around block-level elements
  text = text
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n\n")
    .replace(/<br\s*[\/]?>/gi, "\n");

  // 3. Strip all remaining tags
  text = text.replace(/<[^>]+>/g, " ");

  // 4. Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

  // 5. Clean up excessive whitespace
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Fetches a web page and extracts its readable text content.
 */
export async function scrapeWebPage(
  url: string,
  timeoutMs = 5000,
  maxChars = 4000,
): Promise<{ text: string; title?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { text: "" };
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return { text: "" };
    }

    const rawHtml = await res.text();

    // Extract title if present
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(rawHtml);
    const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : undefined;

    const cleaned = htmlToCleanText(rawHtml);
    const text = cleaned.length > maxChars ? cleaned.slice(0, maxChars) + "..." : cleaned;

    return { text, title };
  } catch (err) {
    // Fail gracefully on timeout or network blocks
    return { text: "" };
  }
}

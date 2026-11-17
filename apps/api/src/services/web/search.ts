import type { WebSearchOptions, WebSearchResult } from "./types.js";
import { scrapeWebPage, htmlToCleanText } from "./scraper.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Clean DuckDuckGo redirect URLs (e.g. //duckduckgo.com/l/?uddg=https%3A%2F%2F...)
 */
function cleanDuckDuckGoUrl(rawUrl: string): string {
  try {
    if (rawUrl.startsWith("//")) {
      rawUrl = "https:" + rawUrl;
    }
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * Strips conversational filler and question prefixes to produce clean search keywords.
 */
export function extractSearchKeywords(query: string): string {
  return query
    .replace(
      /\b(check|the|web|online|internet|again|please|can|you|what|happened|happend|is|are|tell|me|about|recent|recently|news|regarding|have|has|do|does|did)\b/gi,
      " ",
    )
    .replace(/[?!,."']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search via DuckDuckGo HTML using GET (Zero config, 100% free, no API key required)
 */
async function searchDuckDuckGo(
  query: string,
  maxResults = 5,
  timeoutMs = 5000,
): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    clearTimeout(timer);

    if (res.ok) {
      const html = await res.text();
      const titleMatches = [
        ...html.matchAll(
          /<a[^>]+class=["']result__a["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        ),
      ];
      const snippetMatches = [
        ...html.matchAll(/<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi),
      ];

      for (let i = 0; i < titleMatches.length && results.length < maxResults; i++) {
        const titleMatch = titleMatches[i];
        if (!titleMatch || !titleMatch[1] || !titleMatch[2]) continue;

        const rawHref = titleMatch[1];
        const title = htmlToCleanText(titleMatch[2]);
        const url = cleanDuckDuckGoUrl(rawHref);

        const snippetMatch = snippetMatches[i];
        const snippet =
          snippetMatch && snippetMatch[1] ? htmlToCleanText(snippetMatch[1]) : title;

        if (url && (title || snippet)) {
          results.push({
            title: title || url,
            url,
            snippet: snippet || title,
            source: "duckduckgo",
          });
        }
      }
    }
  } catch (err) {
    // Fail gracefully
  }

  // Fallback to Instant Answer API if HTML scraper had 0 results
  if (results.length === 0) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const instantRes = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
        {
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT },
        },
      );
      clearTimeout(timer);

      if (instantRes.ok) {
        const data = (await instantRes.json()) as any;
        if (data.AbstractText && data.AbstractURL) {
          results.push({
            title: data.Heading || query,
            url: data.AbstractURL,
            snippet: data.AbstractText,
            source: "duckduckgo",
          });
        }
        if (Array.isArray(data.RelatedTopics)) {
          for (const item of data.RelatedTopics.slice(0, maxResults - results.length)) {
            if (item.Text && item.FirstURL) {
              results.push({
                title: item.Text.slice(0, 60),
                url: item.FirstURL,
                snippet: item.Text,
                source: "duckduckgo",
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return results;
}

/**
 * Search Google News RSS (100% Free, real-time 2026 news articles, zero bot-blocking)
 */
async function searchGoogleNews(
  query: string,
  maxResults = 5,
  timeoutMs = 5000,
): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timer);

    if (res.ok) {
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];

      for (let i = 0; i < items.length && results.length < maxResults; i++) {
        const item = items[i];
        if (!item || !item[1]) continue;
        const block = item[1];

        const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(block);
        const linkMatch = /<link>([\s\S]*?)<\/link>/i.exec(block);
        const descMatch = /<description>([\s\S]*?)<\/description>/i.exec(block);

        const title = titleMatch && titleMatch[1] ? htmlToCleanText(titleMatch[1]) : "";
        const link = linkMatch && linkMatch[1] ? linkMatch[1].trim() : "";
        const snippet = descMatch && descMatch[1] ? htmlToCleanText(descMatch[1]) : title;

        if (title && link) {
          results.push({
            title,
            url: link,
            snippet,
            source: "google_news",
          });
        }
      }
    }
  } catch {}
  return results;
}

/**
 * Search Wikipedia (Academic, high-uptime fallback)
 */
async function searchWikipedia(
  query: string,
  maxResults = 3,
  timeoutMs = 4000,
): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const cleanQuery = extractSearchKeywords(query) || query;
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&utf8=&format=json&origin=*`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "RecallAI/1.0 (academic study assistant)" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = (await res.json()) as any;
      const searchItems = data?.query?.search || [];
      for (const item of searchItems.slice(0, maxResults)) {
        const title = item.title;
        const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
        const snippet = htmlToCleanText(item.snippet || "");
        results.push({
          title: `Wikipedia: ${title}`,
          url: pageUrl,
          snippet,
          source: "wikipedia",
        });
      }
    }
  } catch {
    // ignore
  }
  return results;
}

/**
 * Unified Free Web Search Engine:
 * 1. Queries DuckDuckGo GET (returns clean current web articles).
 * 2. If results < 2, queries Google News RSS (up-to-the-minute real-time news).
 * 3. If results < 2, queries Wikipedia with cleaned keywords.
 * 4. Extracts full article content for the top result.
 */
export async function searchWeb(
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResult[]> {
  const maxResults = options.maxResults ?? 5;
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchContent = options.fetchContent ?? true;

  let results: WebSearchResult[] = [];

  // 1. DuckDuckGo GET
  results = await searchDuckDuckGo(query, maxResults, timeoutMs);

  // If query had conversational noise, try with cleaned keywords on DuckDuckGo
  if (results.length === 0) {
    const keywords = extractSearchKeywords(query);
    if (keywords && keywords !== query) {
      results = await searchDuckDuckGo(keywords, maxResults, timeoutMs);
    }
  }

  // 2. Google News RSS (Especially powerful for recent events, people, and tech updates)
  if (results.length < 3) {
    const newsResults = await searchGoogleNews(query, maxResults - results.length, timeoutMs);
    for (const n of newsResults) {
      if (!results.some((r) => r.title === n.title || r.url === n.url)) {
        results.push(n);
      }
    }
    if (results.length < 3) {
      const keywords = extractSearchKeywords(query);
      if (keywords && keywords !== query) {
        const kwNews = await searchGoogleNews(keywords, 3, timeoutMs);
        for (const n of kwNews) {
          if (!results.some((r) => r.title === n.title || r.url === n.url) && results.length < maxResults) {
            results.push(n);
          }
        }
      }
    }
  }

  // 3. Wikipedia for academic concepts, theories, and historical entities
  if (results.length < 2) {
    const wikiResults = await searchWikipedia(query, 3, timeoutMs);
    for (const w of wikiResults) {
      if (!results.some((r) => r.url === w.url) && results.length < maxResults) {
        results.push(w);
      }
    }
  }

  // 4. Enrich top 2 results with full scraped article text
  if (fetchContent && results.length > 0) {
    const enrichTargets = results.slice(0, 2);
    await Promise.all(
      enrichTargets.map(async (r) => {
        if (!r.content && r.url && !r.url.startsWith("https://news.google.com/rss/")) {
          const scraped = await scrapeWebPage(r.url, 4000, 3000);
          if (scraped.text) {
            r.content = scraped.text;
          }
        }
      }),
    );
  }

  return results;
}

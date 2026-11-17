export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  source: "duckduckgo" | "google_news" | "wikipedia" | "tavily" | "brave";
}

export interface WebSearchOptions {
  maxResults?: number;
  fetchContent?: boolean;
  timeoutMs?: number;
}

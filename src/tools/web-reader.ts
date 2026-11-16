import { z } from "zod";

import { truncateHead } from "./output-budget";
import { redactSecrets } from "../security/secrets";
import type { ToolOutput } from "../types/tool-output";
import type { AgentTool, ToolRegistry } from "./registry";

export type WebSearchProvider = "tavily" | "brave" | "exa" | "firecrawl" | "duckduckgo";
export type WebSearchProviderChoice = WebSearchProvider | "random";
export type WebFetchFormat = "markdown" | "text" | "html";

/** Per-session search state. Cooldowns stay shared across sessions. */
export interface WebSearchSession {
  preferredProvider?: WebSearchProvider;
}

export interface WebReaderOptions {
  fetchImpl?: typeof fetch;
  /** Abort signal from the calling tool, so stopping a worker cancels its request. */
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  endpoints?: {
    tavily?: string;
    brave?: string;
    exa?: string;
    firecrawl?: string;
    duckduckgo?: string;
  };
  search?: {
    enabled?: boolean;
    provider?: WebSearchProviderChoice;
    max_results?: number;
  };
  fetch?: {
    enabled?: boolean;
    max_chars?: number;
  };
  /** A fixed session, used by tests and direct callers. */
  session?: WebSearchSession;
  /** Resolves the current session at call time. */
  getSession?: () => WebSearchSession | undefined;
}

export interface WebFetchOptions extends WebReaderOptions {
  format?: WebFetchFormat;
  timeout?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

const SearchRequestSchema = z.object({
  query: z.string().min(1), maxResults: z.number().int().min(1).max(20).optional(),
  includeDomains: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i)).max(100).optional(),
  excludeDomains: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i)).max(100).optional(),
  page: z.number().int().min(0).max(9).optional().describe("Brave page offset; pins requests to Brave. Follow returned continuation only."),
  startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
}).refine((value) => !value.startDate || !value.endDate || value.startDate <= value.endDate, "startDate must not follow endDate");
export type WebSearchRequest = z.infer<typeof SearchRequestSchema>;

export interface WebSearchResult {
  provider: WebSearchProvider;
  results: SearchResult[];
  limitations?: string[];
  nextPage?: number;
  truncated?: boolean;
}

const DEFAULT_ENDPOINTS = {
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  exa: "https://api.exa.ai/search",
  firecrawl: "https://api.firecrawl.dev/v2/search",
  duckduckgo: "https://html.duckduckgo.com/html/",
};

const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; Orchivox/1.0; +https://github.com/orchivox)";
const DEFAULT_FETCH_TIMEOUT_SECONDS = 30;
const MAX_FETCH_TIMEOUT_SECONDS = 120;
const DEFAULT_SEARCH_RESULTS = 8;
const NO_RESULTS = "No search results found. Please try a different query.";

const providerCooldowns = new Map<WebSearchProvider, number>();

export function resetWebSearchCooldowns(): void {
  providerCooldowns.clear();
}

export function registerWebTools(registry: ToolRegistry, options: WebReaderOptions = {}): void {
  if (options.search?.enabled !== false) registry.register(createWebSearchTool(options));
  if (options.fetch?.enabled !== false) registry.register(createWebFetchTool(options));
}

export function createWebSearchTool(options: WebReaderOptions = {}): AgentTool<z.ZodTypeAny, ToolOutput> {
  return {
    name: "web_search",
    description: [
      "Search the web. includeDomains/excludeDomains accept hostnames; startDate/endDate use YYYY-MM-DD. Filters require Tavily or Exa; unsupported adapters are skipped. Brave exposes pages 0–9 through continuation; other adapters require refining the query.",
      `The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`,
    ].join(" "),
    parameters: SearchRequestSchema,
    readOnly: true,
    concurrency: "shared",
    execute: async (args, context) => {
      const request = SearchRequestSchema.parse(args);
      const result = await webSearch(
        request,
        { ...options, signal: context?.signal },
      );
      return { status: result.limitations?.length ? "partial" : result.results.length ? "success" : "empty",
        text: formatSearchResults(request.query, result), data: JSON.parse(JSON.stringify({ provider: result.provider, results: result.results, filters: request, limitations: result.limitations ?? [] })),
        sources: result.results.filter((item) => item.url).map((item) => ({ uri: item.url, title: item.title })),
        coverage: { scope: `Web index (${result.provider}); bounded ranked results, total unknown`, complete: false, returned: result.results.length, unit: "results" },
        truncation: { truncated: result.truncated === true, reason: "Backend returns bounded ranked results; total web matches are unknown." },
        continuation: result.nextPage === undefined ? { tool: "web_search", message: "This result exposes no pagination continuation. Refine the query or filters; use web_fetch to read a source." } : { tool: "web_search", arguments: { ...request, maxResults: Math.min(request.maxResults ?? options.search?.max_results ?? DEFAULT_SEARCH_RESULTS, 20), page: result.nextPage }, message: "Fetch the next Brave page. Live rankings can change or overlap." },
      };
    },
  };
}

export function createWebFetchTool(options: WebReaderOptions = {}): AgentTool<z.ZodTypeAny, string> {
  return {
    name: "web_fetch",
    description:
      "Fetch content from an HTTP or HTTPS URL as markdown, text, or HTML. Markdown is the default. Understands plain HTML pages, GitHub repositories and files, arXiv papers, and PDF documents.",
    parameters: z.object({
      url: z.string().min(1).describe("The HTTP or HTTPS URL to fetch."),
      format: z
        .enum(["markdown", "text", "html"])
        .default("markdown")
        .describe("Output format. Defaults to markdown."),
      timeout: z
        .number()
        .int()
        .positive()
        .max(MAX_FETCH_TIMEOUT_SECONDS)
        .optional()
        .describe(`Optional timeout in seconds (maximum: ${MAX_FETCH_TIMEOUT_SECONDS}).`),
    }),
    readOnly: true,
    concurrency: "shared",
    execute: async (args, context) => {
      const request = args as { url: string; format: WebFetchFormat; timeout?: number };
      return webFetch(request.url, {
        ...options,
        format: request.format,
        timeout: request.timeout,
        signal: context?.signal,
      });
    },
  };
}

function formatSearchResults(query: string, result: WebSearchResult): string {
  if (result.results.length === 0) return [NO_RESULTS, ...(result.limitations ?? [])].join("\n");
  const lines = [`# Search results for "${query}" (${result.provider})`, ...(result.limitations ?? []), ""];
  for (const item of result.results) {
    lines.push(`## [${item.title || item.url}](${item.url})`);
    if (item.published) lines.push(`Published: ${item.published}`);
    if (item.snippet) lines.push("", item.snippet);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function webSearch(
  request: WebSearchRequest,
  options: WebReaderOptions = {},
): Promise<WebSearchResult> {
  request = SearchRequestSchema.parse(request);
  options.signal?.throwIfAborted();
  const filtered = !!(request.includeDomains?.length || request.excludeDomains?.length || request.startDate || request.endDate);
  const env = options.env ?? globalThis.process.env;
  const session = options.session ?? options.getSession?.();
  const providers = providerOrder(
    options.search?.provider,
    env,
    session?.preferredProvider,
  );
  const requestedMax = request.maxResults ?? options.search?.max_results ?? DEFAULT_SEARCH_RESULTS;
  const maxResults = Math.min(requestedMax, 20);
  const errors: string[] = requestedMax > 20 ? ["Configured result count capped at 20 for backend compatibility."] : [];
  let emptyProvider: WebSearchProvider | undefined;
  const now = Date.now();
  for (const provider of providers) {
    options.signal?.throwIfAborted();
    if (request.page !== undefined && provider !== "brave") { errors.push(`${provider}: pagination unsupported; skipped`); continue; }
    if (filtered && provider !== "tavily" && provider !== "exa") { errors.push(`${provider}: domain/date filters unsupported by this adapter; skipped`); continue; }
    if ((providerCooldowns.get(provider) ?? 0) > now) { errors.push(`${provider}: cooling down`); continue; }
    try {
      const page = await searchWith(provider, request.query, maxResults, options, request);
      const results = page.results;
      options.signal?.throwIfAborted();
      if (results.length === 0) {
        emptyProvider = provider;
        errors.push(`${provider}: no results`);
        continue;
      }
      if (session) session.preferredProvider = provider;
      return { provider, results: results.slice(0, maxResults), ...(page.nextPage !== undefined ? { nextPage: page.nextPage } : {}), ...(results.length > maxResults ? { truncated: true } : {}), ...(errors.length ? { limitations: errors.map(redactSecrets) } : {}) };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof WebSearchRateLimitError) {
        setProviderCooldown(provider, error.retryAfterMs);
      }
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (emptyProvider) {
    const limitations = errors.filter((error) => !error.endsWith(": no results")).map(redactSecrets);
    return { provider: emptyProvider, results: [], ...(limitations.length ? { limitations } : {}) };
  }
  if (errors.length === 0) {
    throw new Error("search failed because every provider is cooling down");
  }
  throw new Error(`Web search failed; results could not be retrieved. ${redactSecrets(errors.join("; "))}`);
}

function providerOrder(
  choice: WebSearchProviderChoice | undefined,
  env: Record<string, string | undefined>,
  preferred?: WebSearchProvider,
): WebSearchProvider[] {
  const available: WebSearchProvider[] = [];
  if (env.TAVILY_API_KEY) available.push("tavily");
  if (env.BRAVE_API_KEY) available.push("brave");
  if (env.EXA_API_KEY) available.push("exa");
  if (env.FIRECRAWL_API_KEY) available.push("firecrawl");
  available.push("duckduckgo");
  if (!choice || choice === "random") {
    if (preferred && available.includes(preferred)) {
      return [preferred, ...available.filter((provider) => provider !== preferred)];
    }
    return available;
  }
  return [choice, ...available.filter((provider) => provider !== choice)];
}

class WebSearchRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(provider: WebSearchProvider, retryAfterMs: number) {
    super(`${provider} rate limited`);
    this.retryAfterMs = retryAfterMs;
  }
}

function setProviderCooldown(provider: WebSearchProvider, retryAfterMs: number): void {
  providerCooldowns.set(provider, Date.now() + Math.max(1000, retryAfterMs));
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(1000, timestamp - Date.now());
  return 60_000;
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function searchInit(init: RequestInit, signal?: AbortSignal): RequestInit {
  return { ...init, signal: requestSignal(30_000, signal) };
}

function assertSearchResponse(response: Response, provider: WebSearchProvider): void {
  if (response.status === 429) {
    throw new WebSearchRateLimitError(provider, parseRetryAfter(response.headers.get("retry-after")));
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function searchWith(
  provider: WebSearchProvider,
  query: string,
  maxResults: number,
  options: WebReaderOptions,
  filters: WebSearchRequest,
): Promise<{ results: SearchResult[]; nextPage?: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? globalThis.process.env;
  const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };

  if (provider === "tavily") {
    const key = requireKey(env, "TAVILY_API_KEY");
    const response = await fetchImpl(
      endpoints.tavily,
      searchInit({
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: maxResults, ...(filters.includeDomains?.length ? { include_domains: filters.includeDomains } : {}), ...(filters.excludeDomains?.length ? { exclude_domains: filters.excludeDomains } : {}), ...(filters.startDate ? { start_date: filters.startDate } : {}), ...(filters.endDate ? { end_date: filters.endDate } : {}) }),
      }, options.signal),
    );
    assertSearchResponse(response, provider);
    const body = (await readJson(response)) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
    };
    return { results: (body.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.content ?? "",
      published: item.published_date,
    })) };
  }

  if (provider === "brave") {
    const key = requireKey(env, "BRAVE_API_KEY");
    const response = await fetchImpl(
      `${endpoints.brave}?q=${encodeURIComponent(query)}&count=${maxResults}${filters.page === undefined ? "" : `&offset=${filters.page}`}`,
      searchInit({ headers: { accept: "application/json", "x-subscription-token": key } }, options.signal),
    );
    assertSearchResponse(response, provider);
    const body = (await readJson(response)) as {
      query?: { more_results_available?: boolean };
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
          page_age?: string;
        }>;
      };
    };
    return { results: (body.web?.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.description ?? "",
      published: item.age ?? item.page_age,
    })), ...(body.query?.more_results_available && (filters.page ?? 0) < 9 ? { nextPage: (filters.page ?? 0) + 1 } : {}) };
  }

  if (provider === "exa") {
    const key = requireKey(env, "EXA_API_KEY");
    const response = await fetchImpl(
      endpoints.exa,
      searchInit({
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ query, numResults: maxResults, ...(filters.includeDomains?.length ? { includeDomains: filters.includeDomains } : {}), ...(filters.excludeDomains?.length ? { excludeDomains: filters.excludeDomains } : {}), ...(filters.startDate ? { startPublishedDate: `${filters.startDate}T00:00:00.000Z` } : {}), ...(filters.endDate ? { endPublishedDate: `${filters.endDate}T23:59:59.999Z` } : {}) }),
      }, options.signal),
    );
    assertSearchResponse(response, provider);
    const body = (await readJson(response)) as {
      results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }>;
    };
    return { results: (body.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.text ?? "",
      published: item.publishedDate,
    })) };
  }

  if (provider === "firecrawl") {
    const key = requireKey(env, "FIRECRAWL_API_KEY");
    const response = await fetchImpl(
      endpoints.firecrawl,
      searchInit({
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, limit: maxResults }),
      }, options.signal),
    );
    assertSearchResponse(response, provider);
    const body = (await readJson(response)) as {
      success?: boolean;
      error?: string;
      data?:
        | { web?: Array<{ title?: string; url?: string; description?: string }> }
        | Array<{ title?: string; url?: string; description?: string }>;
    };
    if (body.success === false) throw new Error(body.error ?? "firecrawl search failed");
    const items = Array.isArray(body.data) ? body.data : (body.data?.web ?? []);
    return { results: items.map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.description ?? "",
    })) };
  }

  const response = await fetchImpl(
    `${endpoints.duckduckgo}?q=${encodeURIComponent(query)}`,
    searchInit({ headers: { accept: "text/html" } }, options.signal),
  );
  assertSearchResponse(response, provider);
  return { results: parseDuckDuckGo(await response.text(), maxResults) };
}

export function parseDuckDuckGo(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/\w+>/g;
  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetPattern.exec(html)) !== null) {
    snippets.push(inlineText(snippetMatch[1]));
    if (snippets.length >= maxResults * 2) break;
  }
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null && results.length < maxResults) {
    results.push({
      title: inlineText(match[2]),
      url: decodeDuckDuckGoUrl(match[1]),
      snippet: snippets[results.length] ?? "",
    });
  }
  return results;
}

function decodeDuckDuckGoUrl(href: string): string {
  const marker = "uddg=";
  const index = href.indexOf(marker);
  if (index === -1) return href;
  const encoded = href.slice(index + marker.length).split("&")[0] ?? "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export type WebFetchKind = "html" | "github-repo" | "github-file" | "arxiv" | "pdf" | "raw-text";

export const DEFAULT_FETCH_MAX_CHARS = 24_000;

export function capFetchText(text: string, maxChars = DEFAULT_FETCH_MAX_CHARS): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[web_fetch truncated after ${maxChars} characters. Fetch a narrower resource, a specific range, or a smaller endpoint if the rest is needed.]`;
}

export function classifyWebUrl(url: string): WebFetchKind {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "arxiv.org") return "arxiv";
  if (host === "github.com") return parsed.pathname.includes("/blob/") ? "github-file" : "github-repo";
  if (parsed.pathname.toLowerCase().endsWith(".pdf")) return "pdf";
  if (host === "raw.githubusercontent.com") return "raw-text";
  return "html";
}

export async function webFetch(url: string, options: WebFetchOptions = {}): Promise<string> {
  const content = await fetchWebContent(url, options);
  return capFetchText(content, options.fetch?.max_chars);
}

async function fetchWebContent(url: string, options: WebFetchOptions = {}): Promise<string> {
  assertHttpUrl(url);
  const format = options.format ?? "markdown";
  const timeoutMs = (options.timeout ?? DEFAULT_FETCH_TIMEOUT_SECONDS) * 1000;
  const kind = classifyWebUrl(url);

  switch (kind) {
    case "arxiv":
      return fetchArxiv(url, options, format, timeoutMs);
    case "github-repo":
    case "github-file":
      return fetchGithub(url, kind, options, timeoutMs);
    case "pdf":
      return fetchPdf(url, options, timeoutMs);
    case "raw-text": {
      const { text, contentType } = await fetchText(url, options, "text", timeoutMs);
      return formatFetchOutput(url, contentType, "text", truncate(text));
    }
    default: {
      const { text, contentType } = await fetchText(url, options, format, timeoutMs);
      const output = convertHtml(text, contentType, format, url);
      return formatFetchOutput(url, contentType, format, truncate(output));
    }
  }
}

function assertHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL must use http:// or https://");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use http:// or https://");
  }
  return parsed;
}

function fetchHeaders(format: WebFetchFormat): Record<string, string> {
  const accept =
    format === "markdown"
      ? "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
      : format === "text"
        ? "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        : "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  return {
    "user-agent": DEFAULT_USER_AGENT,
    accept,
    "accept-language": "en-US,en;q=0.9",
  };
}

async function requestWithCloudflareRetry(
  url: string,
  options: WebFetchOptions,
  format: WebFetchFormat,
  timeoutMs: number,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const init: RequestInit = {
    headers: fetchHeaders(format),
    signal: requestSignal(timeoutMs, options.signal),
  };
  let response = await fetchImpl(url, init);
  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    response = await fetchImpl(url, {
      ...init,
      headers: { ...fetchHeaders(format), "user-agent": "orchivox" },
    });
  }
  return response;
}

function mimeFrom(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isTextualMime(mime: string): boolean {
  return (
    !mime ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
  );
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

async function fetchText(
  url: string,
  options: WebFetchOptions,
  format: WebFetchFormat,
  timeoutMs: number,
): Promise<{ text: string; contentType: string }> {
  const response = await requestWithCloudflareRetry(url, options, format, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const contentType = response.headers.get("content-type") ?? "";
  const mime = mimeFrom(contentType);
  if (isImageMime(mime)) throw new Error(`unsupported image content type: ${mime}`);
  if (mime === "application/pdf") throw new Error("PDF responses use the pdf path");
  if (!isTextualMime(mime)) throw new Error(`unsupported content type: ${mime || "unknown"}`);
  return { text: await response.text(), contentType };
}

function convertHtml(content: string, contentType: string, format: WebFetchFormat, url: string): string {
  if (format === "html") return content;
  if (!contentType.toLowerCase().includes("text/html")) return content;
  return format === "markdown" ? htmlToMarkdown(content, url) : htmlToText(content);
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function truncate(text: string): string {
  return truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER }).text;
}

function formatFetchOutput(
  url: string,
  contentType: string,
  format: WebFetchFormat,
  output: string,
): string {
  return `URL: ${url}\nContent-Type: ${contentType || "unknown"}\nFormat: ${format}\n\n${output}`;
}

async function fetchArxiv(
  url: string,
  options: WebFetchOptions,
  format: WebFetchFormat,
  timeoutMs: number,
): Promise<string> {
  const idMatch = /arxiv\.org\/(?:abs|pdf|html)\/([0-9]+\.[0-9]+(?:v\d+)?)/.exec(url);
  const id = idMatch?.[1];
  if (id) {
    const htmlUrl = `https://arxiv.org/html/${id}`;
    try {
      const { text, contentType } = await fetchText(htmlUrl, options, format, timeoutMs);
      return formatFetchOutput(
        htmlUrl,
        contentType,
        format,
        truncate(convertHtml(text, contentType, format, htmlUrl)),
      );
    } catch {
      // Fall back to the abstract page.
    }
  }
  const absUrl = id ? `https://arxiv.org/abs/${id}` : url;
  const { text, contentType } = await fetchText(absUrl, options, format, timeoutMs);
  return formatFetchOutput(
    absUrl,
    contentType,
    format,
    truncate(convertHtml(text, contentType, format, absUrl)),
  );
}

async function fetchGithub(
  url: string,
  kind: "github-repo" | "github-file",
  options: WebFetchOptions,
  timeoutMs: number,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";
  const init = (headers: Record<string, string>): RequestInit => ({
    headers: { ...headers, "user-agent": DEFAULT_USER_AGENT },
    signal: requestSignal(timeoutMs, options.signal),
  });

  if (parts.length === 2) {
    const sections: string[] = [`# GitHub: ${owner}/${repo}`];
    for (const branch of ["main", "master"]) {
      const readme = await fetchImpl(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`,
        init({ accept: "text/plain" }),
      ).catch(() => undefined);
      if (readme && readme.ok) {
        sections.push(`## README (${branch})\n\n${await readme.text()}`);
        break;
      }
    }
    const contents = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/contents/`,
      init({ accept: "application/vnd.github+json" }),
    ).catch(() => undefined);
    if (contents && contents.ok) {
      const entries = (await readJson(contents)) as Array<{ name?: string; type?: string }>;
      sections.push(
        `## Top level entries\n\n${entries.map((entry) => `- ${entry.type === "dir" ? "dir" : "file"}: ${entry.name}`).join("\n")}`,
      );
    }
    return formatFetchOutput(url, "text/markdown", "markdown", truncate(sections.join("\n\n")));
  }

  if (kind === "github-file") {
    const branch = parts[3] ?? "main";
    const path = parts.slice(4).join("/");
    const raw = await fetchImpl(
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
      init({ accept: "text/plain" }),
    );
    if (!raw.ok) throw new Error(`HTTP ${raw.status} for ${owner}/${repo}/${path}`);
    return formatFetchOutput(
      url,
      raw.headers.get("content-type") ?? "text/plain",
      "markdown",
      truncate(`# ${owner}/${repo}: ${path}\n\n\`\`\`\n${await raw.text()}\n\`\`\``),
    );
  }

  const branch = parts[3] ?? "main";
  const path = parts.slice(4).join("/");
  const contents = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    init({ accept: "application/vnd.github+json" }),
  );
  if (!contents.ok) throw new Error(`HTTP ${contents.status} for ${owner}/${repo}/${path}`);
  const entries = (await readJson(contents)) as Array<{ name?: string; type?: string }>;
  return formatFetchOutput(
    url,
    "application/json",
    "markdown",
    truncate(
      `# ${owner}/${repo}: tree ${path || "/"}\n\n${entries.map((entry) => `- ${entry.type === "dir" ? "dir" : "file"}: ${entry.name}`).join("\n")}`,
    ),
  );
}

async function fetchPdf(url: string, options: WebFetchOptions, timeoutMs: number): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: { "user-agent": DEFAULT_USER_AGENT },
    signal: requestSignal(timeoutMs, options.signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = await extractPdfText(bytes);
  return formatFetchOutput(url, "application/pdf", "text", truncate(text));
}

export function htmlToMarkdown(html: string, baseUrl: string): string {
  let document = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  document = document
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(document);
  const title = titleMatch ? inlineText(titleMatch[1]) : baseUrl;
  document = document.replace(/<title[^>]*>[\s\S]*?<\/title>/i, "");

  const codeBlocks: string[] = [];
  document = document.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_full, inner: string) => {
    const code = inlineText(inner).replace(/```/g, "``");
    codeBlocks.push(code);
    return `\n@@CODEBLOCK${codeBlocks.length - 1}@@\n`;
  });

  const anchors: string[] = [];
  document = document.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_full, level: string, inner: string) => {
      const heading = inlineText(inner);
      anchors.push(slugify(heading));
      return `\n\n@@ANCHOR${anchors.length - 1}@@\n${"#".repeat(Math.min(Number(level) + 1, 6))} ${heading}\n\n`;
    },
  );
  document = document.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_full, inner: string) => `\n- ${inlineText(inner)}`);
  document = document.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_full, href: string, inner: string) => {
    const text = inlineText(inner);
    return `[${text}](${resolveUrl(href, baseUrl)})`;
  });
  document = document.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_full, _tag: string, inner: string) => `**${inlineText(inner)}**`);
  document = document.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_full, _tag: string, inner: string) => `*${inlineText(inner)}*`);
  document = document.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_full, inner: string) => `\`${inlineText(inner)}\``);
  document = document.replace(/<(br|hr)\s*\/?>/gi, "\n");
  document = document.replace(/<\/(p|div|section|article|tr|table|ul|ol)>/gi, "\n\n");
  document = document.replace(/<[^>]+>/g, "");
  document = decodeEntities(document);
  document = document.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const withCode = document
    .replace(/@@CODEBLOCK(\d+)@@/g, (_full, index: string) => {
      return `\`\`\`\n${codeBlocks[Number(index)] ?? ""}\n\`\`\``;
    })
    .replace(/@@ANCHOR(\d+)@@/g, (_full, index: string) => `<a id="${anchors[Number(index)] ?? "section"}"></a>`);
  return `# ${title}\n\n${withCode}`;
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const raw = latin1(bytes);
  const sections: string[] = [];
  let page = 0;
  let cursor = 0;
  while (true) {
    const streamStart = raw.indexOf("stream", cursor);
    if (streamStart === -1) break;
    const streamEnd = raw.indexOf("endstream", streamStart);
    if (streamEnd === -1) break;
    const dictionary = raw.slice(Math.max(0, streamStart - 400), streamStart);
    const contentStart = raw[streamStart + 6] === "\r" || raw[streamStart + 6] === "\n" ? streamStart + 7 : streamStart + 6;
    let contentBytes = bytes.subarray(contentStart, streamEnd);
    while (
      contentBytes.length > 0 &&
      (contentBytes[contentBytes.length - 1] === 10 || contentBytes[contentBytes.length - 1] === 13)
    ) {
      contentBytes = contentBytes.subarray(0, contentBytes.length - 1);
    }
    if (dictionary.includes("FlateDecode")) {
      const inflated = await inflate(contentBytes);
      if (inflated) contentBytes = inflated;
    }
    const text = extractTextOperators(latin1(contentBytes));
    if (text.trim().length > 0) {
      page += 1;
      sections.push(`## Page ${page}\n\n${text.trim()}`);
    }
    cursor = streamEnd + 9;
  }
  return sections.length > 0 ? sections.join("\n\n") : "_no extractable text found in this PDF_";
}

function extractTextOperators(content: string): string {
  const lines: string[] = [];
  let current = "";
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    if (char === "(") {
      const { text, next } = readPdfLiteral(content, index);
      current += text;
      index = next;
      continue;
    }
    if (content.startsWith("Tj", index) || content.startsWith("TJ", index)) {
      if (current.trim().length > 0) lines.push(current.trim());
      current = "";
      index += 2;
      continue;
    }
    if (content.startsWith("Td", index) || content.startsWith("TD", index) || content.startsWith("T*", index)) {
      if (current.trim().length > 0) lines.push(current.trim());
      current = "";
      index += 2;
      continue;
    }
    if (content.startsWith("ET", index)) {
      if (current.trim().length > 0) lines.push(current.trim());
      current = "";
      index += 2;
      continue;
    }
    index += 1;
  }
  if (current.trim().length > 0) lines.push(current.trim());
  return lines.join("\n");
}

function readPdfLiteral(content: string, start: number): { text: string; next: number } {
  let text = "";
  let index = start + 1;
  let depth = 1;
  while (index < content.length && depth > 0) {
    const char = content[index];
    if (char === "\\") {
      const next = content[index + 1];
      if (next === "n") text += "\n";
      else if (next === "r") text += "\r";
      else if (next === "t") text += "\t";
      else if (next && /[0-7]/.test(next)) {
        const octal = content.slice(index + 1, index + 4);
        text += String.fromCharCode(parseInt(octal, 8));
        index += 3;
      } else if (next !== undefined) text += next;
      index += 2;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        break;
      }
    }
    text += char;
    index += 1;
  }
  return { text, next: index };
}

async function inflate(data: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "section";
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function requireKey(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`request failed with status ${response.status}`);
  return response.json();
}

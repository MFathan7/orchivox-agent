import { z } from "zod";

import { truncateHead } from "./output-budget";
import type { AgentTool, ToolRegistry } from "./registry";

export type WebSearchProvider = "tavily" | "brave" | "exa" | "duckduckgo";
export type WebSearchProviderChoice = WebSearchProvider | "random";
export type WebFetchFormat = "markdown" | "text" | "html";

export interface WebReaderOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  endpoints?: {
    tavily?: string;
    brave?: string;
    exa?: string;
    duckduckgo?: string;
  };
  search?: {
    enabled?: boolean;
    provider?: WebSearchProviderChoice;
  };
  fetch?: {
    enabled?: boolean;
    max_chars?: number;
  };
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

export interface WebSearchResult {
  provider: WebSearchProvider;
  results: SearchResult[];
}

const DEFAULT_ENDPOINTS = {
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  exa: "https://api.exa.ai/search",
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

export function createWebSearchTool(options: WebReaderOptions = {}): AgentTool {
  return {
    name: "web_search",
    description: [
      "Search the web for current information beyond your knowledge cutoff.",
      `The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`,
    ].join(" "),
    parameters: z.object({
      query: z.string().min(1).describe("Web search query."),
    }),
    readOnly: true,
    execute: async (args) => {
      const request = args as { query: string };
      const result = await webSearch(request, options);
      return formatSearchResults(request.query, result);
    },
  };
}

export function createWebFetchTool(options: WebReaderOptions = {}): AgentTool {
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
    execute: async (args) => {
      const request = args as { url: string; format: WebFetchFormat; timeout?: number };
      return webFetch(request.url, { ...options, format: request.format, timeout: request.timeout });
    },
  };
}

function formatSearchResults(query: string, result: WebSearchResult): string {
  if (result.results.length === 0) return NO_RESULTS;
  const lines = [`# Search results for "${query}" (${result.provider})`, ""];
  for (const item of result.results) {
    lines.push(`## [${item.title || item.url}](${item.url})`);
    if (item.published) lines.push(`Published: ${item.published}`);
    if (item.snippet) lines.push("", item.snippet);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function webSearch(
  request: { query: string; maxResults?: number },
  options: WebReaderOptions = {},
): Promise<WebSearchResult> {
  const env = options.env ?? globalThis.process.env;
  const providers = providerOrder(options.search?.provider, env);
  const errors: string[] = [];
  let lastProvider: WebSearchProvider = providers[0] ?? "duckduckgo";
  const now = Date.now();
  for (const provider of providers) {
    lastProvider = provider;
    if ((providerCooldowns.get(provider) ?? 0) > now) continue;
    try {
      const results = await searchWith(
        provider,
        request.query,
        request.maxResults ?? DEFAULT_SEARCH_RESULTS,
        options,
      );
      if (results.length === 0) {
        errors.push(`${provider}: no results`);
        continue;
      }
      return { provider, results };
    } catch (error) {
      if (error instanceof WebSearchRateLimitError) {
        setProviderCooldown(provider, error.retryAfterMs);
      }
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length === 0) {
    throw new Error("search failed because every provider is cooling down");
  }
  return { provider: lastProvider, results: [] };
}

function providerOrder(
  choice: WebSearchProviderChoice | undefined,
  env: Record<string, string | undefined>,
): WebSearchProvider[] {
  const available: WebSearchProvider[] = [];
  if (env.TAVILY_API_KEY) available.push("tavily");
  if (env.BRAVE_API_KEY) available.push("brave");
  if (env.EXA_API_KEY) available.push("exa");
  available.push("duckduckgo");
  if (!choice || choice === "random") return available;
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

function searchInit(init: RequestInit): RequestInit {
  return { ...init, signal: AbortSignal.timeout(30_000) };
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
): Promise<SearchResult[]> {
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
        body: JSON.stringify({ query, max_results: maxResults }),
      }),
    );
    assertSearchResponse(response, provider);
    const body = (await readJson(response)) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
    };
    return (body.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.content ?? "",
      published: item.published_date,
    }));
  }

  if (provider === "brave") {
    const key = requireKey(env, "BRAVE_API_KEY");
    const response = await fetchImpl(
      `${endpoints.brave}?q=${encodeURIComponent(query)}&count=${maxResults}`,
      searchInit({ headers: { accept: "application/json", "x-subscription-token": key } }),
    );
    assertSearchResponse(response, provider);
    const body = (await readJson(response)) as {
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
    return (body.web?.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.description ?? "",
      published: item.age ?? item.page_age,
    }));
  }

  if (provider === "exa") {
    const key = requireKey(env, "EXA_API_KEY");
    const response = await fetchImpl(
      endpoints.exa,
      searchInit({
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ query, numResults: maxResults }),
      }),
    );
    assertSearchResponse(response, provider);
    const body = (await readJson(response)) as {
      results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }>;
    };
    return (body.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.text ?? "",
      published: item.publishedDate,
    }));
  }

  const response = await fetchImpl(
    `${endpoints.duckduckgo}?q=${encodeURIComponent(query)}`,
    searchInit({ headers: { accept: "text/html" } }),
  );
  assertSearchResponse(response, provider);
  return parseDuckDuckGo(await response.text(), maxResults);
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
    signal: AbortSignal.timeout(timeoutMs),
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
    signal: AbortSignal.timeout(timeoutMs),
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
    signal: AbortSignal.timeout(timeoutMs),
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

import { z } from "zod";

import type { AgentTool, ToolRegistry } from "./registry";

export interface WebReaderOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  endpoints?: {
    tavily?: string;
    brave?: string;
    exa?: string;
    duckduckgo?: string;
  };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DEFAULT_ENDPOINTS = {
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  exa: "https://api.exa.ai/search",
  duckduckgo: "https://html.duckduckgo.com/html/",
};

export function registerWebTools(registry: ToolRegistry, options: WebReaderOptions = {}): void {
  registry.register(createWebSearchTool(options));
  registry.register(createWebFetchTool(options));
}

export function createWebSearchTool(options: WebReaderOptions = {}): AgentTool {
  return {
    name: "web_search",
    description:
      "Search the web. Uses Tavily, Brave, or Exa when their API keys are set (TAVILY_API_KEY, BRAVE_API_KEY, EXA_API_KEY) and falls back to DuckDuckGo.",
    parameters: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().max(20).default(8),
      provider: z.enum(["tavily", "brave", "exa", "duckduckgo"]).optional(),
    }),
    readOnly: true,
    execute: async (args) => {
      const request = args as { query: string; maxResults: number; provider?: "tavily" | "brave" | "exa" | "duckduckgo" };
      return webSearch(request, options);
    },
  };
}

export function createWebFetchTool(options: WebReaderOptions = {}): AgentTool {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL and return readable Markdown with section anchors. Understands plain HTML pages, GitHub repositories and files, arXiv papers, and PDF documents.",
    parameters: z.object({
      url: z.string().min(1),
      maxChars: z.number().int().positive().max(200_000).default(20_000),
    }),
    readOnly: true,
    execute: async (args) => {
      const request = args as { url: string; maxChars: number };
      const markdown = await webFetch(request.url, options);
      return markdown.length > request.maxChars
        ? `${markdown.slice(0, request.maxChars)}\n\n... truncated after ${request.maxChars} characters`
        : markdown;
    },
  };
}

async function webSearch(
  request: { query: string; maxResults: number; provider?: "tavily" | "brave" | "exa" | "duckduckgo" },
  options: WebReaderOptions,
): Promise<string> {
  const order: Array<"tavily" | "brave" | "exa" | "duckduckgo"> = request.provider
    ? [request.provider]
    : ["tavily", "brave", "exa", "duckduckgo"];
  const errors: string[] = [];
  for (const provider of order) {
    try {
      const results = await searchWith(provider, request.query, request.maxResults, options);
      if (results.length === 0) continue;
      return [
        `# Search results for "${request.query}" (${provider})`,
        "",
        ...results.map((result, index) => `${index + 1}. [${result.title}](${result.url})\n   ${result.snippet}`),
      ].join("\n");
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`search failed for every provider. ${errors.join("; ")}`);
}

async function searchWith(
  provider: "tavily" | "brave" | "exa" | "duckduckgo",
  query: string,
  maxResults: number,
  options: WebReaderOptions,
): Promise<SearchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? globalThis.process.env;
  const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };

  if (provider === "tavily") {
    const key = requireKey(env, "TAVILY_API_KEY");
    const response = await fetchImpl(endpoints.tavily, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    const body = (await readJson(response)) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (body.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.content ?? "",
    }));
  }

  if (provider === "brave") {
    const key = requireKey(env, "BRAVE_API_KEY");
    const response = await fetchImpl(`${endpoints.brave}?q=${encodeURIComponent(query)}&count=${maxResults}`, {
      headers: { accept: "application/json", "x-subscription-token": key },
    });
    const body = (await readJson(response)) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (body.web?.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.description ?? "",
    }));
  }

  if (provider === "exa") {
    const key = requireKey(env, "EXA_API_KEY");
    const response = await fetchImpl(endpoints.exa, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, numResults: maxResults }),
    });
    const body = (await readJson(response)) as { results?: Array<{ title?: string; url?: string; text?: string }> };
    return (body.results ?? []).map((item) => ({
      title: item.title ?? item.url ?? "untitled",
      url: item.url ?? "",
      snippet: item.text ?? "",
    }));
  }

  const response = await fetchImpl(`${endpoints.duckduckgo}?q=${encodeURIComponent(query)}`, {
    headers: { accept: "text/html" },
  });
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

export function classifyWebUrl(url: string): WebFetchKind {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "arxiv.org") return "arxiv";
  if (host === "github.com") return parsed.pathname.includes("/blob/") ? "github-file" : "github-repo";
  if (parsed.pathname.toLowerCase().endsWith(".pdf")) return "pdf";
  if (host === "raw.githubusercontent.com") return "raw-text";
  return "html";
}

export async function webFetch(url: string, options: WebReaderOptions = {}): Promise<string> {
  const kind = classifyWebUrl(url);
  switch (kind) {
    case "arxiv":
      return fetchArxiv(url, options);
    case "github-repo":
    case "github-file":
      return fetchGithub(url, kind, options);
    case "pdf":
      return fetchPdf(url, options);
    case "raw-text": {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(url);
      return `# ${url}\n\n\`\`\`\n${await response.text()}\n\`\`\``;
    }
    default:
      return fetchHtml(url, options);
  }
}

async function fetchHtml(url: string, options: WebReaderOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { headers: { accept: "text/html" } });
  return htmlToMarkdown(await response.text(), url);
}

async function fetchArxiv(url: string, options: WebReaderOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const idMatch = /arxiv\.org\/(?:abs|pdf|html)\/([0-9]+\.[0-9]+(?:v\d+)?)/.exec(url);
  const id = idMatch?.[1];
  if (id) {
    const htmlUrl = `https://arxiv.org/html/${id}`;
    const htmlResponse = await fetchImpl(htmlUrl, { headers: { accept: "text/html" } }).catch(() => undefined);
    if (htmlResponse && htmlResponse.ok) {
      return htmlToMarkdown(await htmlResponse.text(), htmlUrl);
    }
  }
  const absUrl = id ? `https://arxiv.org/abs/${id}` : url;
  const response = await fetchImpl(absUrl, { headers: { accept: "text/html" } });
  return htmlToMarkdown(await response.text(), absUrl);
}

async function fetchGithub(url: string, kind: "github-repo" | "github-file", options: WebReaderOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";
  if (parts.length === 2) {
    const sections: string[] = [`# GitHub: ${owner}/${repo}`];
    for (const branch of ["main", "master"]) {
      const readme = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`).catch(
        () => undefined,
      );
      if (readme && readme.ok) {
        sections.push(`## README (${branch})\n\n${await readme.text()}`);
        break;
      }
    }
    const contents = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/contents/`, {
      headers: { accept: "application/vnd.github+json" },
    }).catch(() => undefined);
    if (contents && contents.ok) {
      const entries = (await readJson(contents)) as Array<{ name?: string; type?: string }>;
      sections.push(
        `## Top level entries\n\n${entries.map((entry) => `- ${entry.type === "dir" ? "dir" : "file"}: ${entry.name}`).join("\n")}`,
      );
    }
    return sections.join("\n\n");
  }
  if (kind === "github-file") {
    const branch = parts[3] ?? "main";
    const path = parts.slice(4).join("/");
    const raw = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`);
    return `# ${owner}/${repo}: ${path}\n\n\`\`\`\n${await raw.text()}\n\`\`\``;
  }
  const branch = parts[3] ?? "main";
  const path = parts.slice(4).join("/");
  const contents = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  const entries = (await readJson(contents)) as Array<{ name?: string; type?: string }>;
  return `# ${owner}/${repo}: tree ${path || "/"}\n\n${entries.map((entry) => `- ${entry.type === "dir" ? "dir" : "file"}: ${entry.name}`).join("\n")}`;
}

async function fetchPdf(url: string, options: WebReaderOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = await extractPdfText(bytes);
  return `# PDF: ${url}\n\n${text}`;
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

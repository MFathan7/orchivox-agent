import { describe, expect, it } from "bun:test";

import { ToolRegistry } from "../src/tools/registry";
import {
  createWebFetchTool,
  createWebSearchTool,
  registerWebTools,
  resetWebSearchCooldowns,
  webFetch,
  webSearch,
} from "../src/tools/web-reader";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

const DDG_HTML =
  '<a class="result__a" href="https://example.com/a">Example A</a>' +
  '<div class="result__snippet">Snippet A</div>';

describe("web fetch", () => {
  const html =
    "<html><head><title>Doc</title></head><body><h1>Hello</h1><p>World</p></body></html>";

  for (const format of ["markdown", "text", "html"] as const) {
    it(`renders ${format} responses with metadata`, async () => {
      const fetchImpl = fakeFetch(
        async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      );
      const output = await webFetch("https://example.com/docs", { fetchImpl, format });
      expect(output).toContain("URL: https://example.com/docs");
      expect(output).toContain("Content-Type: text/html; charset=utf-8");
      expect(output).toContain(`Format: ${format}`);
      if (format === "html") {
        expect(output).toContain("<h1>Hello</h1>");
      } else {
        expect(output).toContain("Hello");
      }
    });
  }

  it("rejects non-http URLs and image responses", async () => {
    const fetchImpl = fakeFetch(async () => new Response(""));
    await expect(webFetch("ftp://example.com", { fetchImpl })).rejects.toThrow(
      "http:// or https://",
    );
    const imageFetch = fakeFetch(
      async () => new Response("x", { headers: { "content-type": "image/png" } }),
    );
    await expect(webFetch("https://example.com/pic", { fetchImpl: imageFetch })).rejects.toThrow(
      "unsupported image",
    );
  });

  it("defaults the fetch format to markdown", () => {
    const tool = createWebFetchTool();
    const parsed = tool.parameters.parse({ url: "https://example.com" }) as {
      format: string;
    };
    expect(parsed.format).toBe("markdown");
  });
});

describe("web search", () => {
  it("formats results with source links and falls back to DuckDuckGo", async () => {
    const fetchImpl = fakeFetch(async (url) => {
      if (url.includes("duckduckgo")) {
        return new Response(DDG_HTML, { headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const tool = createWebSearchTool({ fetchImpl, env: {} });
    const output = await tool.execute({ query: "test" });
    expect(output).toContain("## [Example A](https://example.com/a)");
    expect(output).toContain("Snippet A");
  });

  it("cools down a rate-limited provider and keeps using the fallback", async () => {
    resetWebSearchCooldowns();
    const calls: string[] = [];
    const fetchImpl = fakeFetch(async (url) => {
      calls.push(url);
      if (url.includes("tavily")) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      }
      if (url.includes("duckduckgo")) {
        return new Response(DDG_HTML, { headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const env = { TAVILY_API_KEY: "key" };
    const first = await webSearch({ query: "one" }, { fetchImpl, env });
    expect(first.provider).toBe("duckduckgo");
    await webSearch({ query: "two" }, { fetchImpl, env });
    expect(calls.filter((url) => url.includes("tavily"))).toHaveLength(1);
    resetWebSearchCooldowns();
  });

  it("does not register disabled web tools", () => {
    const registry = new ToolRegistry();
    registerWebTools(registry, { search: { enabled: false }, fetch: { enabled: false } });
    expect(registry.has("web_search")).toBe(false);
    expect(registry.has("web_fetch")).toBe(false);
  });
});

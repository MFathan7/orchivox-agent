import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { z } from "zod";

import type { AgentTool } from "./registry";

const Args = z.object({
  url: z.string().url().describe("HTTP(S) URL on localhost, 127.0.0.1, or [::1]."),
  timeoutMs: z.number().int().min(1).max(30_000).default(5_000),
});

export function createLocalHttpProbeTool(): AgentTool<typeof Args, string> {
  return {
    name: "probe_local_http",
    description: "Send one GET request to a local development endpoint and report its HTTP status. Uses loopback, ignores proxy settings, and does not follow redirects or download the response body.",
    parameters: Args,
    readOnly: false,
    concurrency: "shared",
    async execute(args, context) {
      const url = new URL(args.url);
      const localHosts = ["localhost", "127.0.0.1", "[::1]"];
      if (!["http:", "https:"].includes(url.protocol) || !localHosts.includes(url.hostname) || url.username || url.password) {
        throw new Error("Use an HTTP(S) URL on localhost, 127.0.0.1, or [::1] without credentials.");
      }
      const timeout = AbortSignal.timeout(args.timeoutMs);
      const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
      const get = url.protocol === "https:" ? httpsGet : httpGet;
      try {
        return await new Promise<string>((resolve, reject) => {
          const request = get(url, { signal, agent: false, lookup: (_host, options, callback) => {
            if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          } }, (response) => {
            resolve(`HTTP ${response.statusCode}`);
            response.destroy();
          });
          request.once("error", reject);
        });
      } catch (error) {
        context?.signal?.throwIfAborted();
        if (timeout.aborted) throw new Error(`Local HTTP probe timed out after ${args.timeoutMs}ms.`);
        throw error;
      }
    },
  };
}

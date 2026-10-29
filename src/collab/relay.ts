import type { ServerWebSocket } from "bun";

export interface CollabRelayOptions {
  token: string;
  port?: number;
  hostname?: string;
  allowInput?: boolean;
  onInput?: (text: string) => void;
}

export interface CollabSession {
  url: string;
  viewerUrl: string;
  port: number;
  token: string;
}

interface SocketData {
  allowInput: boolean;
}

const KEY_SEED_PREFIX = "orchivox-collab:";

export function deriveCollabKey(token: string): Promise<CryptoKey> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(`${KEY_SEED_PREFIX}${token}`))
    .then((digest) => crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
}

export async function encryptFrame(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return JSON.stringify({
    iv: Buffer.from(iv).toString("base64"),
    ct: Buffer.from(new Uint8Array(ciphertext)).toString("base64"),
  });
}

export async function decryptFrame(key: CryptoKey, payload: string): Promise<string> {
  const parsed = JSON.parse(payload) as { iv?: string; ct?: string };
  if (!parsed.iv || !parsed.ct) throw new Error("malformed collab frame");
  const iv = Uint8Array.from(Buffer.from(parsed.iv, "base64"));
  const ciphertext = Uint8Array.from(Buffer.from(parsed.ct, "base64"));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export class CollabRelay {
  private readonly options: CollabRelayOptions;
  private key: CryptoKey | undefined;
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly sockets = new Set<ServerWebSocket<SocketData>>();
  private session: CollabSession | undefined;

  constructor(options: CollabRelayOptions) {
    this.options = options;
  }

  get viewerCount(): number {
    return this.sockets.size;
  }

  getSession(): CollabSession | undefined {
    return this.session;
  }

  async start(): Promise<CollabSession> {
    if (this.session) return this.session;
    if (this.options.token.trim().length === 0) throw new Error("collab token must not be empty");
    this.key = await deriveCollabKey(this.options.token);

    this.server = Bun.serve<SocketData>({
      hostname: this.options.hostname ?? "127.0.0.1",
      port: this.options.port ?? 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (url.pathname === "/ws") {
          const provided = url.searchParams.get("t");
          if (!provided || provided !== this.options.token) {
            return new Response("unauthorized", { status: 401 });
          }
          server.upgrade(request, { data: { allowInput: this.options.allowInput ?? false } });
          return undefined as unknown as Response;
        }
        return new Response(VIEWER_HTML, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      },
      websocket: {
        open: (socket) => {
          this.sockets.add(socket);
        },
        message: (socket, message) => {
          if (!socket.data.allowInput) return;
          this.options.onInput?.(String(message));
        },
        close: (socket) => {
          this.sockets.delete(socket);
        },
      },
    });

    const hostname = this.options.hostname ?? "127.0.0.1";
    const port = this.server.port ?? this.options.port ?? 0;
    const session: CollabSession = {
      url: `ws://${hostname}:${port}/ws?t=${encodeURIComponent(this.options.token)}`,
      viewerUrl: `http://${hostname}:${port}/#t=${encodeURIComponent(this.options.token)}`,
      port,
      token: this.options.token,
    };
    this.session = session;
    return session;
  }

  async broadcast(frame: string): Promise<void> {
    if (!this.key) return;
    const payload = await encryptFrame(this.key, frame);
    for (const socket of this.sockets) socket.send(payload);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.server?.stop(true);
    this.server = undefined;
    this.session = undefined;
  }
}

const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Orchivox Live Session</title>
<style>
  body { margin: 0; background: #0b0d10; color: #d7dde4; font-family: ui-monospace, monospace; }
  header { padding: 10px 14px; border-bottom: 1px solid #2a2f36; display: flex; gap: 8px; align-items: center; }
  input { background: #14181d; color: #d7dde4; border: 1px solid #2a2f36; padding: 6px 8px; width: 320px; }
  button { background: #1f6feb; color: #fff; border: 0; padding: 6px 12px; cursor: pointer; }
  main { padding: 14px; }
  pre { white-space: pre-wrap; word-break: break-word; line-height: 1.35; margin: 0; }
  #status { color: #8b949e; margin-left: auto; }
</style>
</head>
<body>
<header>
  <strong>Orchivox Live</strong>
  <input id="token" placeholder="room token" autocomplete="off">
  <button id="connect">Connect</button>
  <span id="status">disconnected</span>
</header>
<main><pre id="screen">(waiting for host frames)</pre></main>
<script type="module">
const statusEl = document.getElementById("status");
const screenEl = document.getElementById("screen");
const tokenInput = document.getElementById("token");
const seed = new URLSearchParams(location.hash.replace(/^#/, "")).get("t");
if (seed) tokenInput.value = seed;

async function deriveKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("orchivox-collab:" + token));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
}

function stripAnsi(text) {
  return text
    .replace(/\\u001b\\[\\?2026[hl]/g, "")
    .replace(/\\u001b\\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\\u001b\\][^\\u0007]*\\u0007/g, "");
}

document.getElementById("connect").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    statusEl.textContent = "enter the room token";
    return;
  }
  const key = await deriveKey(token);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(scheme + "://" + location.host + "/ws?t=" + encodeURIComponent(token));
  socket.addEventListener("open", () => {
    statusEl.textContent = "connected (end-to-end encrypted)";
  });
  socket.addEventListener("close", () => {
    statusEl.textContent = "disconnected";
  });
  socket.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(event.data);
      const ciphertext = Uint8Array.from(atob(payload.ct), (c) => c.charCodeAt(0));
      const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      screenEl.textContent = stripAnsi(new TextDecoder().decode(plaintext));
      statusEl.textContent = "connected (end-to-end encrypted) - live";
    } catch (error) {
      statusEl.textContent = "decrypt failed: " + error.message;
    }
  });
});
</script>
</body>
</html>
`;

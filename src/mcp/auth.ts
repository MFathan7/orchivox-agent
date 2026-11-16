import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthTokensSchema, OAuthClientInformationSchema, OAuthClientInformationFullSchema, type OAuthTokens, type OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerConfig } from "../config/loader";
import { redactSecrets } from "../security/secrets";
import { NativeCredentialStore, SessionCredentialStore, type CredentialStore } from "./credentials";
import { runToolProcess } from "../tools/process";

const RecordSchema = z.object({
  client: z.union([OAuthClientInformationFullSchema, OAuthClientInformationSchema]).optional(),
  tokens: OAuthTokensSchema.optional(), expiresAt: z.number().optional(),
});
type AuthRecord = z.infer<typeof RecordSchema>;
export interface McpAuthStatus {
  state: "signed_out" | "login_required" | "authorizing" | "authenticated" | "expired" | "error" | "manual";
  storage: "native" | "session" | "none";
  nativeLabel: string; nativeAvailable: boolean; scope?: string; expiresAt?: number;
  authorizationUrl?: string;
}
export class McpLoginRequired extends Error {
  constructor() { super("MCP login required. Open authentication in /mcp; login starts only when you choose it."); }
}

export class McpSecretRedactor {
  private readonly values = new Set<string>();
  remember(value: unknown): void {
    if (typeof value === "string" && value.length >= 4) { this.values.add(value); this.values.add(encodeURIComponent(value)); }
  }
  record(value: AuthRecord): void {
    for (const secret of [value.tokens?.access_token, value.tokens?.refresh_token, value.tokens?.id_token, value.client?.client_secret]) this.remember(secret);
  }
  redact(value: string): string {
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) value = value.split(secret).join("[redacted]");
    return redactSecrets(value);
  }
  sanitize<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((entry) => this.sanitize(entry)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.sanitize(entry)])) as T;
    return value;
  }
}

class SavedOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  private active = true;
  private writes = Promise.resolve();
  record: AuthRecord;
  readonly nonce = randomBytes(32).toString("base64url");
  constructor(readonly key: string, private readonly store: CredentialStore, private readonly redactor: McpSecretRedactor,
    private readonly config: McpServerConfig, record: AuthRecord, readonly redirectUrl: string,
    private interactive: boolean, private readonly redirected: (url: URL) => void, private readonly changed: () => void) {
    this.record = record; redactor.record(record); redactor.remember(this.nonce);
  }
  get clientMetadata() { return { client_name: "Orchivox Agent", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(this.config.oauth?.scope ? { scope: this.config.oauth.scope } : {}) }; }
  state() { return this.nonce; }
  clientInformation() {
    if (this.record.client) return this.record.client;
    if (this.config.oauth?.client_id) return { client_id: this.config.oauth.client_id, issuer: this.config.oauth.issuer };
    if (!this.interactive) throw new McpLoginRequired();
    return undefined;
  }
  async saveClientInformation(value: OAuthClientInformationMixed) { this.assertActive(); this.record.client = value; this.redactor.record(this.record); if (!this.interactive) await this.persist(); }
  tokens() { this.assertActive(); return this.record.tokens; }
  async saveTokens(value: OAuthTokens) {
    this.assertActive();
    if (!value.issuer) throw new Error("OAuth tokens must be bound to their issuer.");
    this.record.tokens = value; this.record.expiresAt = value.expires_in === undefined ? undefined : Date.now() + value.expires_in * 1000;
    this.redactor.record(this.record); if (!this.interactive) await this.persist(); this.changed();
  }
  saveCodeVerifier(value: string) { this.assertActive(); if (!this.interactive) throw new McpLoginRequired(); this.verifier = value; this.redactor.remember(value); }
  codeVerifier() { this.assertActive(); if (!this.verifier) throw new Error("OAuth verifier is no longer available."); return this.verifier; }
  redirectToAuthorization(url: URL) {
    this.assertActive(); if (!this.interactive) throw new McpLoginRequired(); validateHttpUrl(url, this.config.url); this.redirected(url);
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    this.assertActive();
    if (scope === "all" || scope === "client") delete this.record.client;
    if (scope === "all" || scope === "tokens") { delete this.record.tokens; delete this.record.expiresAt; }
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (!this.interactive) await this.persist(); this.changed();
  }
  private assertActive() { if (!this.active) throw new Error("MCP authorization was cancelled or logged out."); }
  private persist() {
    this.assertActive(); const value = JSON.stringify(this.record);
    const writing = this.writes.then(() => { this.assertActive(); return this.store.write(this.key, value); });
    this.writes = writing.catch(() => {}); return writing;
  }
  async commit() { await this.persist(); this.interactive = false; this.verifier = undefined; }
  async deactivate() { this.active = false; this.verifier = undefined; await this.writes; }
}

function loopback(url: URL) { return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname); }
function validateHttpUrl(url: URL, serverUrl?: string): void {
  if (url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("OAuth requires HTTPS, except for loopback development endpoints.");
  if (serverUrl && loopback(url) && !loopback(new URL(serverUrl))) throw new Error("Remote OAuth discovery cannot use a loopback authorization endpoint.");
}
function manual(config: McpServerConfig) { return config.transport === "stdio" || Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization"); }

export class McpAuthManager {
  readonly redactor = new McpSecretRedactor();
  private readonly native: CredentialStore;
  private readonly session: CredentialStore;
  private readonly providers = new Map<string, SavedOAuthProvider>();
  private readonly states = new Map<string, McpAuthStatus>();
  private readonly pending = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  private readonly listeners = new Set<() => void>();
  private readonly scope: string;
  private closed = false;
  constructor(options: { configPath: string; native?: CredentialStore; session?: CredentialStore; timeoutMs?: number; fetch?: typeof fetch }) {
    this.native = options.native ?? new NativeCredentialStore(); this.session = options.session ?? new SessionCredentialStore();
    this.scope = resolve(options.configPath); this.options = options;
  }
  private readonly options: { timeoutMs?: number; fetch?: typeof fetch };
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private credentialsChanged(key: string) {
    if (this.states.get(key)?.state !== "authorizing") this.update(key, { state: this.providers.get(key)?.record.tokens ? "authenticated" : "login_required" });
    else this.changed();
  }
  private key(server: string, config: McpServerConfig) { return createHash("sha256").update(JSON.stringify([this.scope, server, config.transport, config.url, config.oauth])).digest("hex"); }
  status(server: string, config: McpServerConfig): McpAuthStatus {
    const key = this.key(server, config), value = this.states.get(key);
    const provider = this.providers.get(key);
    const tokenState = provider?.record.tokens ? provider.record.expiresAt !== undefined && provider.record.expiresAt <= Date.now() ? "expired" : "authenticated" : "signed_out";
    const state: McpAuthStatus["state"] = manual(config) ? "manual" : value && !["signed_out", "authenticated", "expired"].includes(value.state) ? value.state : tokenState;
    return { storage: "none", nativeLabel: this.native.label, nativeAvailable: this.native.available, ...value, state,
      ...(provider?.record.tokens ? { scope: provider.record.tokens.scope === undefined ? undefined : this.redactor.redact(provider.record.tokens.scope), expiresAt: provider.record.expiresAt } : {}) };
  }
  private update(key: string, value: Partial<McpAuthStatus>) {
    this.states.set(key, { state: "signed_out", storage: "none", nativeLabel: this.native.label, nativeAvailable: this.native.available, ...this.states.get(key), ...value }); this.changed();
  }
  rememberConfig(config: McpServerConfig) {
    for (const value of Object.values(config.headers)) { this.redactor.remember(value); if (/^Bearer /i.test(value)) this.redactor.remember(value.slice(7)); }
    for (const [key, value] of Object.entries(config.env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)$/i.test(key)) this.redactor.remember(value);
  }
  private async read(store: CredentialStore, key: string): Promise<AuthRecord> {
    const raw = await store.read(key); if (!raw) return {};
    try {
      const value = RecordSchema.parse(JSON.parse(raw)); if (value.tokens && !value.tokens.issuer) throw new Error(); return value;
    } catch { throw new Error("Saved MCP credentials are invalid. Log out before signing in again."); }
  }
  async provider(server: string, config: McpServerConfig): Promise<OAuthClientProvider | undefined> {
    if (this.closed) throw new Error("MCP authorization manager is closed.");
    this.rememberConfig(config); if (manual(config)) return undefined;
    const key = this.key(server, config), existing = this.providers.get(key); if (existing) return existing;
    try { validateHttpUrl(new URL(config.url!)); } catch { return undefined; }
    const storage = this.native.available ? "native" : "session", store = storage === "native" ? this.native : this.session;
    let record: AuthRecord = {}, unreadable = false;
    try { record = await this.read(store, key); } catch { unreadable = true; }
    if (this.closed) throw new Error("MCP authorization manager is closed.");
    const provider = new SavedOAuthProvider(key, store, this.redactor, config, record, `http://127.0.0.1:${config.oauth?.redirect_port ?? 1}/mcp/oauth/callback`, false, () => {}, () => this.credentialsChanged(key));
    this.providers.set(key, provider); this.update(key, { storage, state: unreadable ? "error" : record.tokens ? "authenticated" : "signed_out" }); return provider;
  }
  required(server: string, config: McpServerConfig) { this.update(this.key(server, config), { state: "login_required", authorizationUrl: undefined }); }
  cancel(server: string, config: McpServerConfig) { this.pending.get(this.key(server, config))?.controller.abort(); }
  async cancelLogin(server: string, config: McpServerConfig) {
    this.cancel(server, config); await this.pending.get(this.key(server, config))?.done.catch(() => {});
    return `Login cancelled for ${server}.`;
  }
  async openLogin(server: string, config: McpServerConfig): Promise<string> {
    if (this.closed) throw new Error("MCP authorization manager is closed.");
    const url = this.status(server, config).authorizationUrl;
    if (!url || !this.pending.has(this.key(server, config))) throw new Error("Start login before opening its authorization page.");
    validateHttpUrl(new URL(url), config.url);
    const script = '$ErrorActionPreference="Stop"; $loginUrl=[Console]::In.ReadToEnd(); $loginStart=[System.Diagnostics.ProcessStartInfo]::new($loginUrl); $loginStart.UseShellExecute=$true; [System.Diagnostics.Process]::Start($loginStart) | Out-Null';
    const argv = process.platform === "win32" ? [Bun.which("powershell.exe") ?? "pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
      : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
    try { const result = await runToolProcess(argv, { ...(process.platform === "win32" ? { input: url } : {}), timeoutMs: 10000 }); if (result.code !== 0) throw new Error(); }
    catch { throw new Error("Browser could not be opened. Open the sign-in URL shown in the authentication menu."); }
    return "Opened the authorization page in this computer's browser.";
  }
  login(server: string, config: McpServerConfig, storage: "native" | "session", signal?: AbortSignal): Promise<string> {
    if (this.closed) throw new Error("MCP authorization manager is closed.");
    const key = this.key(server, config);
    if (this.pending.has(key)) throw new Error("A login is already active for this server.");
    if (manual(config)) throw new Error("This server uses stdio or a manual Authorization header. Manage those credentials outside OAuth login.");
    if (storage === "native" && !this.native.available) throw new Error("OS credential store is unavailable. Choose memory-only login.");
    validateHttpUrl(new URL(config.url!));
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const done = this.loginFlow(server, config, storage, controller.signal).finally(() => { signal?.removeEventListener("abort", abort); this.pending.delete(key); });
    this.pending.set(key, { controller, done }); return done;
  }
  private async loginFlow(server: string, config: McpServerConfig, storage: "native" | "session", signal: AbortSignal): Promise<string> {
    const key = this.key(server, config), store = storage === "native" ? this.native : this.session;
    const previous = await store.read(key); let attemptedSave = false;
    let callback: ReturnType<typeof Bun.serve> | undefined, provider: SavedOAuthProvider | undefined;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 180000), combined = AbortSignal.any([signal, timeout]);
    this.update(key, { state: "authorizing", storage, authorizationUrl: undefined });
    let accepted = false;
    let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; }); code.catch(() => {});
    const stop = () => rejectCode(new Error("MCP login cancelled or timed out.")); combined.addEventListener("abort", stop, { once: true });
    try {
      combined.throwIfAborted();
      callback = Bun.serve({ hostname: "127.0.0.1", port: config.oauth?.redirect_port ?? 0, fetch: (request) => {
        const url = new URL(request.url);
        const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'" };
        if (accepted || request.method !== "GET" || url.host !== `127.0.0.1:${callback!.port}` || url.pathname !== "/mcp/oauth/callback") return new Response("Invalid callback.", { status: 400, headers });
        const state = Buffer.from(url.searchParams.get("state") ?? ""), expected = Buffer.from(provider!.nonce);
        if (url.searchParams.getAll("state").length !== 1 || state.length !== expected.length || !timingSafeEqual(state, expected)) return new Response("Invalid authorization state.", { status: 400, headers });
        if (url.searchParams.has("iss") && url.searchParams.get("iss") !== (provider!.record.client?.issuer ?? config.oauth?.issuer)) return new Response("Invalid authorization issuer.", { status: 400, headers });
        if (url.searchParams.has("error")) { accepted = true; this.update(key, { authorizationUrl: undefined }); rejectCode(new Error("Authorization was denied by the user or service.")); return new Response("Authorization denied. Return to Orchivox.", { headers }); }
        const value = url.searchParams.get("code"); if (!value || url.searchParams.getAll("code").length !== 1) return new Response("Authorization code missing.", { status: 400, headers });
        accepted = true; this.update(key, { authorizationUrl: undefined }); this.redactor.remember(value); resolveCode(value); return new Response("Authorization received. Return to Orchivox.", { headers });
      } });
      provider = new SavedOAuthProvider(key, store, this.redactor, config, {}, `http://127.0.0.1:${callback.port}/mcp/oauth/callback`, true,
        (url) => this.update(key, { authorizationUrl: url.href }), () => this.changed());
      const fetcher = this.networkFetch(config, combined, true);
      const response = await fetcher(config.url!, { headers: { accept: "application/json, text/event-stream" } });
      const challenge = extractWWWAuthenticateParams(response); await response.body?.cancel();
      const result = await auth(provider, { serverUrl: config.url!, scope: config.oauth?.scope ?? challenge.scope, resourceMetadataUrl: challenge.resourceMetadataUrl, fetchFn: fetcher });
      if (result === "REDIRECT") await auth(provider, { serverUrl: config.url!, authorizationCode: await code, scope: config.oauth?.scope ?? challenge.scope, resourceMetadataUrl: challenge.resourceMetadataUrl, fetchFn: fetcher });
      combined.throwIfAborted(); attemptedSave = true; await provider.commit(); combined.throwIfAborted();
      await this.providers.get(key)?.deactivate(); this.providers.delete(key); combined.throwIfAborted(); this.providers.set(key, provider);
      this.update(key, { state: "authenticated", storage, authorizationUrl: undefined }); return `Signed in to ${server}. Credentials use ${store.label}.`;
    } catch (error) {
      await provider?.deactivate();
      let cleanupFailed = false;
      try { if (attemptedSave) { if (previous === undefined) await store.remove(key); else await store.write(key, previous); } } catch { cleanupFailed = true; }
      this.update(key, { state: cleanupFailed ? "error" : combined.aborted ? "signed_out" : "error", authorizationUrl: undefined });
      if (cleanupFailed) throw new Error("MCP login stopped, but credential cleanup failed. Unlock the OS store and retry logout.");
      throw new Error(combined.aborted ? "MCP login cancelled or timed out." : "MCP login failed. Check OAuth configuration, server availability, and credential-store access.");
    } finally { combined.removeEventListener("abort", stop); callback?.stop(); }
  }
  private fetcher(signal?: AbortSignal, serverUrl?: string): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); validateHttpUrl(url, serverUrl);
      return (this.options.fetch ?? fetch)(input, { ...init, signal: AbortSignal.any([...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30000)]), redirect: init?.redirect ?? "manual" });
    }) as typeof fetch;
  }
  private networkFetch(config: McpServerConfig, signal?: AbortSignal, interactive = false): typeof fetch {
    const fetcher = this.fetcher(signal, config.url), endpoint = new URL(config.url!);
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      let rpc = false;
      try { rpc = typeof init?.body === "string" && JSON.parse(init.body).jsonrpc === "2.0"; } catch {}
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const refresh = method === "POST" && (typeof init?.body === "string" || init?.body instanceof URLSearchParams) && new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token";
      if (!interactive && method === "POST" && !rpc && !refresh) throw new McpLoginRequired();
      if (url.origin === endpoint.origin && (rpc || ["GET", "DELETE"].includes(method) && url.pathname === endpoint.pathname)) for (const [key, value] of Object.entries(config.headers)) headers.set(key, value);
      return fetcher(input, { ...init, headers });
    }) as typeof fetch;
  }
  transportFetch(config: McpServerConfig): typeof fetch { return this.networkFetch(config); }
  async refresh(server: string, config: McpServerConfig, signal?: AbortSignal): Promise<string> {
    if (manual(config)) throw new Error("Manual credentials cannot be refreshed by OAuth.");
    const key = this.key(server, config); const provider = await this.provider(server, config) as SavedOAuthProvider;
    if (!provider.record.tokens?.refresh_token) throw new McpLoginRequired();
    try { await auth(provider, { serverUrl: config.url!, scope: config.oauth?.scope, fetchFn: this.networkFetch(config, signal) }); this.update(key, { state: "authenticated" }); return `Refreshed credentials for ${server}.`; }
    catch { this.required(server, config); throw new Error("MCP token refresh failed. Sign in again; no login was started automatically."); }
  }
  async logout(server: string, config: McpServerConfig): Promise<string> {
    if (this.closed) throw new Error("MCP authorization manager is closed.");
    const key = this.key(server, config); this.cancel(server, config); await this.pending.get(key)?.done.catch(() => {});
    await this.providers.get(key)?.deactivate(); this.providers.delete(key);
    try { await this.session.remove(key); if (this.native.available) await this.native.remove(key); }
    catch { this.update(key, { state: "error", authorizationUrl: undefined }); throw new Error("Local OAuth credential deletion failed. Stored credentials may remain; unlock the OS store and retry logout."); }
    this.update(key, { state: "signed_out", storage: "none", authorizationUrl: undefined }); return `Signed out of ${server}. ${this.native.available ? "Local saved OAuth credentials were deleted." : "Session credentials were deleted; the unavailable OS store was not accessed."} Manual headers/env are unchanged; remote grants are managed by the service.`;
  }
  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    await Promise.allSettled([...this.pending.values()].map((pending) => pending.done));
    await Promise.all([...this.providers.values()].map((provider) => provider.deactivate())); this.providers.clear(); this.listeners.clear();
  }
}

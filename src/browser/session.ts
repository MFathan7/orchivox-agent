import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserConfig } from "../config/loader";
import { killProcessTree } from "../tools/process-tree";
import { abortableDelay } from "../tools/session-runtime";
import { CdpClient } from "./cdp-client";

export function browserExecutable(configured?: string): string | undefined {
  if (configured) return Bun.which(configured) ?? (existsSync(configured) ? configured : undefined);
  for (const name of ["chromium", "chromium-browser", "google-chrome", "chrome", "msedge"]) { const path = Bun.which(name); if (path) return path; }
  const candidates = process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : process.platform === "win32" ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((root): root is string => !!root).flatMap((root) => [join(root, "Google", "Chrome", "Application", "chrome.exe"), join(root, "Microsoft", "Edge", "Application", "msedge.exe")]) : [];
  return candidates.find((path) => existsSync(path));
}
export class BrowserSession {
  private client?: CdpClient;
  private child?: ReturnType<typeof Bun.spawn>;
  private profile?: string;
  private readonly created = new Set<string>();
  private readonly attached = new Map<string, string>();
  private selected?: string;
  private closing?: Promise<void>;
  private stderr = "";
  constructor(readonly owned: boolean, private readonly config: BrowserConfig) {}
  get state() { return this.closing ? "closed" : this.client?.connected ? "connected" : this.client ? "disconnected" : "starting"; }
  async open(signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      let endpoint: string;
      if (this.owned) {
        const executable = browserExecutable(this.config.executable);
        if (!executable) throw new Error("Chromium/Chrome/Edge executable unavailable. Set browser.executable or install a supported browser separately.");
        this.profile = await mkdtemp(join(tmpdir(), "orchivox-browser-")); signal.throwIfAborted();
        this.child = Bun.spawn([executable, ...this.config.args, ...(this.config.headless ? ["--headless=new"] : []), "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${this.profile}`, "about:blank"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: process.platform !== "win32" });
        void (async () => { try { for await (const chunk of this.child!.stderr as ReadableStream<Uint8Array>) this.stderr = (this.stderr + new TextDecoder().decode(chunk)).slice(-4000); } catch {} })();
        for (;;) {
          signal.throwIfAborted();
          if (this.child.exitCode !== null) throw new Error(`Browser exited before CDP was ready: ${this.stderr.slice(-1500)}`);
          const active = await readFile(join(this.profile, "DevToolsActivePort"), "utf8").catch(() => "");
          const [port, path] = active.trim().split(/\r?\n/);
          if (/^\d+$/.test(port ?? "") && path?.startsWith("/devtools/browser/")) { endpoint = `ws://127.0.0.1:${port}${path}`; break; }
          await abortableDelay(25, signal);
        }
      } else {
        if (!this.config.attach_url) throw new Error("Attach requires an explicitly configured browser.attach_url. No existing profile was opened.");
        const url = new URL(this.config.attach_url);
        if (url.protocol === "http:" || url.protocol === "https:") {
          const response = await fetch(new URL("/json/version", url), { signal });
          if (!response.ok) throw new Error(`CDP discovery failed (HTTP ${response.status}).`);
          const metadata = await response.json() as { webSocketDebuggerUrl?: string };
          if (!metadata.webSocketDebuggerUrl) throw new Error("CDP endpoint did not return a browser WebSocket URL."); endpoint = metadata.webSocketDebuggerUrl;
        } else endpoint = url.toString();
      }
      this.client = await CdpClient.connect(endpoint!, signal, this.config.timeout_ms); signal.throwIfAborted();
      this.client.onDisconnect(() => { void this.close().catch(() => {}); });
      await this.newTab(signal);
    } catch (error) { await this.close(); throw error; }
  }
  private rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal, sessionId?: string) {
    if (!this.client) throw new Error("Browser has no CDP connection."); return this.client.request(method, params, signal, sessionId);
  }
  async tabs(signal: AbortSignal) {
    const result = await this.rpc("Target.getTargets", {}, signal);
    const tabs = (result.targetInfos as Array<{ targetId: string; type: string; title: string; url: string }>).filter((target) => target.type === "page");
    return { tabs: tabs.slice(0, 100).map(({ targetId, title, url }) => ({ targetId, title, url, owned: this.created.has(targetId) })), partial: tabs.length > 100 };
  }
  async newTab(signal: AbortSignal) {
    if (this.created.size >= this.config.max_tabs) throw new Error(`Owned tab capacity ${this.config.max_tabs} reached. Close an owned tab first.`);
    const { targetId } = await this.rpc("Target.createTarget", { url: "about:blank" }, signal); this.created.add(targetId); this.selected = targetId; return { targetId };
  }
  private async page(targetId: string | undefined, signal: AbortSignal) {
    const target = targetId ?? this.selected; if (!target) throw new Error("Choose a page targetId from tabs.");
    if (!(await this.tabs(signal)).tabs.some((page) => page.targetId === target)) throw new Error("Page targetId is unavailable or outside the first 100 listed pages.");
    let sessionId = this.attached.get(target);
    if (!sessionId) { sessionId = (await this.rpc("Target.attachToTarget", { targetId: target, flatten: true }, signal)).sessionId; this.attached.set(target, sessionId!); await this.rpc("Page.enable", {}, signal, sessionId); }
    return { target, sessionId: sessionId! };
  }
  private async evaluate(expression: string, targetId: string | undefined, signal: AbortSignal) {
    const { sessionId } = await this.page(targetId, signal);
    const result = await this.rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, signal, sessionId);
    if (result.exceptionDetails) throw new Error("Browser DOM operation failed. Observe the page and selector before retrying."); return result.result?.value;
  }
  async navigate(url: string, targetId: string | undefined, signal: AbortSignal) {
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("Navigation accepts HTTP/HTTPS URLs only.");
    const { target, sessionId } = await this.page(targetId, signal);
    const waitController = new AbortController(), combined = AbortSignal.any([signal, waitController.signal]);
    const waiting = this.client!.waitFor("Page.loadEventFired", sessionId, combined); waiting.catch(() => {});
    try {
      const result = await this.rpc("Page.navigate", { url }, signal, sessionId);
      if (result.errorText) throw new Error(`Navigation failed: ${String(result.errorText).slice(0, 500)}`);
      if (result.loaderId) await waiting;
      return { targetId: target, url };
    } finally { waitController.abort(); }
  }

  async observe(targetId: string | undefined, signal: AbortSignal) {
    return this.evaluate(`(() => { const selector = (el) => { if (el.id) return '#' + CSS.escape(el.id); const parts = []; for (let node = el; node && node.nodeType === 1; node = node.parentElement) { const tag = node.localName; const peers = node.parentElement ? [...node.parentElement.children].filter(x => x.localName === tag) : [node]; parts.unshift(tag + ':nth-of-type(' + (peers.indexOf(node) + 1) + ')'); } return parts.join(' > '); }; const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role],[tabindex]')].filter(el => el.getClientRects().length); return { url: location.href, title: document.title, text: document.body?.innerText.slice(0,24000) ?? '', elements: elements.slice(0,200).map(el => ({ selector: selector(el), tag: el.localName, role: el.getAttribute('role'), label: el.getAttribute('aria-label'), text: (el.innerText ?? '').slice(0,200), placeholder: el.getAttribute('placeholder'), type: el.getAttribute('type') })), partial: elements.length > 200 }; })()`, targetId, signal);
  }
  async click(selector: string, targetId: string | undefined, signal: AbortSignal) {
    const point = await this.evaluate(`(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}); if (all.length !== 1) throw Error('Expected one element'); const el = all[0]; if (el.disabled) throw Error('Disabled element'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); if (!r.width || !r.height) throw Error('Invisible element'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`, targetId, signal);
    const { sessionId } = await this.page(targetId, signal);
    await this.rpc("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, signal, sessionId);
    await this.rpc("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, signal, sessionId);
    await this.rpc("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, signal, sessionId);
    return { clicked: selector };
  }
  async fill(selector: string, text: string, targetId: string | undefined, signal: AbortSignal) {
    return this.evaluate(`(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}); if (all.length !== 1) throw Error('Expected one element'); const el = all[0]; if (el.disabled || el.readOnly || !['INPUT','TEXTAREA'].includes(el.tagName)) throw Error('Element cannot be filled'); el.focus(); const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,${JSON.stringify(text)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {filled:true}; })()`, targetId, signal);
  }
  async press(key: string, targetId: string | undefined, signal: AbortSignal) {
    const { sessionId } = await this.page(targetId, signal);
    const virtualKeys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, " ": 32 };
    for (const type of ["keyDown", "keyUp"]) await this.rpc("Input.dispatchKeyEvent", { type, key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: virtualKeys[key], ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}) }, signal, sessionId);
    return { pressed: key };
  }
  async screenshot(targetId: string | undefined, signal: AbortSignal): Promise<string> {
    const { sessionId } = await this.page(targetId, signal); const result = await this.rpc("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, signal, sessionId);
    if (typeof result.data !== "string") throw new Error("Browser returned no screenshot."); return result.data;
  }
  async closeTab(targetId: string | undefined, signal: AbortSignal) {
    const target = targetId ?? this.selected;
    if (!target || !this.created.has(target)) throw new Error("Only tabs created by this session can be closed.");
    await this.rpc("Target.closeTarget", { targetId: target }, signal); this.created.delete(target); this.attached.delete(target); if (this.selected === target) this.selected = [...this.created].at(-1);
    return { closed: target };
  }
  async close() {
    return this.closing ??= (async () => {
      if (this.client?.connected) {
        if (this.owned) await this.client.request("Browser.close", {}, AbortSignal.timeout(500)).catch(() => {});
        else await Promise.all([...this.created].map((targetId) => this.client!.request("Target.closeTarget", { targetId }, AbortSignal.timeout(500)).catch(() => {})));
      }
      this.client?.close();
      if (this.child) { killProcessTree(this.child, { force: true }); await this.child.exited.catch(() => {}); }
      if (this.profile) await rm(this.profile, { recursive: true, force: true }).catch(() => {});
      this.created.clear(); this.attached.clear();
    })();
  }
}

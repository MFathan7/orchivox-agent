import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ToolRegistry } from "../src/tools/registry";
import { BackgroundProcessManager } from "../src/tools/bg-process";
import {
  callVisionProvider,
  createInspectImageTool,
  parseImageMetadata,
} from "../src/tools/vision";
import { ProviderRouter } from "../src/provider/router";
import type { AppConfig } from "../config/loader";

const TEST_DIR = resolve(process.cwd(), ".agent/test-plan18");

async function setupTestDir(): Promise<void> {
  if (existsSync(TEST_DIR)) {
    await rm(TEST_DIR, { recursive: true, force: true });
  }
  await mkdir(TEST_DIR, { recursive: true });
}

function createPngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  // PNG signature
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk length: 13
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  // IHDR chunk type
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  // Width (big endian)
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  // 8-bit depth, RGB, compression, filter, interlace
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}

function createGifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(14);
  // GIF89a signature
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  // Width and height (little endian)
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function createJpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20);
  // SOI marker
  bytes.set([0xff, 0xd8], 0);
  // SOF0 marker (baseline DCT)
  bytes.set([0xff, 0xc0], 2);
  // Length (big endian): 11 bytes
  bytes.set([0x00, 0x0b], 4);
  // Precision
  bytes[6] = 8;
  const view = new DataView(bytes.buffer);
  // Height and width (big endian)
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  return bytes;
}

function createWebpVp8xBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  // RIFF signature
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  // Size
  bytes.set([0x16, 0x00, 0x00, 0x00], 4);
  // WEBP
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  // VP8X chunk
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  // Chunk size: 10
  bytes.set([0x0a, 0x00, 0x00, 0x00], 16);
  // Flags
  bytes.set([0x00, 0x00, 0x00, 0x00], 20);
  // Canvas width - 1 (24 bit little endian)
  const w = width - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  // Canvas height - 1 (24 bit little endian)
  const h = height - 1;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

describe("BackgroundProcessManager", () => {
  it("starts a long-running process asynchronously and retrieves info", async () => {
    const manager = new BackgroundProcessManager();
    const info = await manager.start({
      id: "test-echo-server",
      command: "echo 'Server listening on http://localhost:3456'; sleep 2",
    });

    expect(info.id).toBe("test-echo-server");
    expect(info.pid).toBeGreaterThan(0);
    expect(info.status).toBe("running");

    // Allow process output stream to flush
    await new Promise((resolve) => setTimeout(resolve, 150));

    const updated = manager.getProcess("test-echo-server");
    expect(updated).toBeDefined();
    expect(updated?.listeningUrls).toContain("http://localhost:3456");

    await manager.stop("test-echo-server");
  });

  it("waits for ready regex and detects ready state", async () => {
    const manager = new BackgroundProcessManager();
    const info = await manager.start({
      id: "test-ready-proc",
      command: "echo 'Initializing components...'; echo 'Listening on port 8080'; sleep 2",
      waitForReadyRegex: "Listening on port",
      readyTimeoutMs: 3000,
    });

    expect(info.id).toBe("test-ready-proc");
    expect(info.status).toBe("ready");
    expect(info.listeningUrls).toContain("http://localhost:8080");

    await manager.stop("test-ready-proc");
  });

  it("reads logs with line limits, regex filters, and sinceLastRead pagination", async () => {
    const manager = new BackgroundProcessManager();
    await manager.start({
      id: "test-logs-proc",
      command: "echo 'INFO: started'; echo 'WARN: high memory'; echo 'INFO: heartbeat 1'; sleep 2",
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Initial logs read
    const logs1 = manager.getLogs("test-logs-proc", { lines: 10 });
    expect(logs1.lines.length).toBeGreaterThanOrEqual(3);
    expect(logs1.formatted).toContain("WARN: high memory");

    // Filter by regex
    const filtered = manager.getLogs("test-logs-proc", { filterRegex: "WARN" });
    expect(filtered.lines.length).toBe(1);
    expect(filtered.lines[0].text).toContain("WARN: high memory");

    // sinceLastRead returns 0 when no new lines arrived
    const sinceLast = manager.getLogs("test-logs-proc", { sinceLastRead: true });
    expect(sinceLast.lines.length).toBe(0);

    await manager.stop("test-logs-proc");
  });

  it("lists all tracked background processes and cleans them up with stopAll", async () => {
    const manager = new BackgroundProcessManager();
    await manager.start({
      id: "proc-1",
      command: "echo 'proc 1 running'; sleep 3",
    });
    await manager.start({
      id: "proc-2",
      command: "echo 'proc 2 running'; sleep 3",
    });

    const listBefore = manager.list();
    expect(listBefore.length).toBe(2);
    expect(listBefore.map((p) => p.id)).toContain("proc-1");
    expect(listBefore.map((p) => p.id)).toContain("proc-2");

    await manager.stopAll();

    const proc1 = manager.getProcess("proc-1");
    const proc2 = manager.getProcess("proc-2");
    expect(proc1?.status).toBe("stopped");
    expect(proc2?.status).toBe("stopped");
  });

  it("registers 4 tools to ToolRegistry and executes bg_start, bg_list, bg_logs, bg_stop", async () => {
    const registry = new ToolRegistry();
    const manager = new BackgroundProcessManager();
    manager.registerTools(registry);

    expect(registry.has("bg_start")).toBe(true);
    expect(registry.has("bg_logs")).toBe(true);
    expect(registry.has("bg_list")).toBe(true);
    expect(registry.has("bg_stop")).toBe(true);

    const startTool = registry.get("bg_start")!;
    const startOutput = await startTool.execute({
      id: "tool-proc-test",
      command: "echo 'Service ready on http://127.0.0.1:9090'; sleep 2",
    });
    expect(typeof startOutput).toBe("string");
    expect(startOutput).toContain("Background process started:");
    expect(startOutput).toContain("tool-proc-test");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const listTool = registry.get("bg_list")!;
    const listOutput = await listTool.execute({});
    expect(listOutput).toContain("tool-proc-test");

    const logsTool = registry.get("bg_logs")!;
    const logsOutput = await logsTool.execute({
      processId: "tool-proc-test",
      lines: 5,
    });
    expect(logsOutput).toContain("[PROCESS LOGS: tool-proc-test]");

    const stopTool = registry.get("bg_stop")!;
    const stopOutput = await stopTool.execute({
      processId: "tool-proc-test",
    });
    expect(stopOutput).toContain("successfully stopped");
  });
});

describe("Multimodal Vision Inspector", () => {
  it("decodes binary image dimensions for PNG, GIF, JPEG, and WebP", () => {
    // PNG 800x600 (4:3)
    const pngBytes = createPngBytes(800, 600);
    const pngMeta = parseImageMetadata(pngBytes);
    expect(pngMeta).not.toBeNull();
    expect(pngMeta?.format).toBe("png");
    expect(pngMeta?.width).toBe(800);
    expect(pngMeta?.height).toBe(600);
    expect(pngMeta?.aspectRatio).toBe("4:3");

    // GIF 320x240 (4:3)
    const gifBytes = createGifBytes(320, 240);
    const gifMeta = parseImageMetadata(gifBytes);
    expect(gifMeta).not.toBeNull();
    expect(gifMeta?.format).toBe("gif");
    expect(gifMeta?.width).toBe(320);
    expect(gifMeta?.height).toBe(240);

    // JPEG 1920x1080 (16:9)
    const jpegBytes = createJpegBytes(1920, 1080);
    const jpegMeta = parseImageMetadata(jpegBytes);
    expect(jpegMeta).not.toBeNull();
    expect(jpegMeta?.format).toBe("jpeg");
    expect(jpegMeta?.width).toBe(1920);
    expect(jpegMeta?.height).toBe(1080);
    expect(jpegMeta?.aspectRatio).toBe("16:9");

    // WebP 1280x720 (16:9)
    const webpBytes = createWebpVp8xBytes(1280, 720);
    const webpMeta = parseImageMetadata(webpBytes);
    expect(webpMeta).not.toBeNull();
    expect(webpMeta?.format).toBe("webp");
    expect(webpMeta?.width).toBe(1280);
    expect(webpMeta?.height).toBe(720);
    expect(webpMeta?.aspectRatio).toBe("16:9");
  });

  it("returns null for truncated or invalid image data", () => {
    const invalidBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(parseImageMetadata(invalidBytes)).toBeNull();
  });

  it("handles callVisionProvider fallback when no router is attached", async () => {
    const result = await callVisionProvider({
      base64Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      mimeType: "image/png",
      prompt: "Describe this UI",
    });

    expect(result).toContain("Image received and verified.");
  });

  it("executes inspect_image on a local PNG image file and parses metadata", async () => {
    await setupTestDir();
    const testImgPath = resolve(TEST_DIR, "test-screenshot.png");
    const pngData = createPngBytes(1024, 768);
    await writeFile(testImgPath, pngData);

    const tool = createInspectImageTool({ repoRoot: TEST_DIR });
    const output = await tool.execute({
      imagePath: testImgPath,
      prompt: "Find any alignment errors in the header bar.",
    });

    expect(output).toContain("[IMAGE INSPECTION REPORT: FILE]");
    expect(output).toContain("Dimensions: 1024x768 (4:3, PNG)");
    expect(output).toContain('Analysis Prompt: "Find any alignment errors in the header bar."');
  });

  it("throws validation error when inspect_image has neither imagePath, imageUrl, nor clipboard", async () => {
    const tool = createInspectImageTool();
    expect(
      tool.execute({
        prompt: "Check this",
      } as any),
    ).rejects.toThrow();
  });

  it("throws error when local image file does not exist", async () => {
    const tool = createInspectImageTool({ repoRoot: TEST_DIR });
    expect(
      tool.execute({
        imagePath: "non-existent-image-file-1234.png",
      }),
    ).rejects.toThrow("Image file not found");
  });
});

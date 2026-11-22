import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import React from "react";

import { runUpdate, type UpdateOffer } from "../src/app-info";
import { currentPlatform } from "../src/installer/platform";
import { InstallerUI } from "../src/installer/ui";
import { INSTALLATION_LOGO_HEIGHT, INSTALLATION_ORBIT_FRAMES, installationLogo } from "../src/tui/logo-art";
import { getTheme } from "../src/tui/theme";
import { UpdatePanel } from "../src/tui/update-panel";

test("signed update offers can be deferred before the binary is downloaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchivox-update-"));
  const platform = currentPlatform();
  const manifestUrl = "https://updates.example.test/latest.json";
  const assetUrl = "https://updates.example.test/runtime.gz";
  const manifest = JSON.stringify({
    schema: 1, version: "9.0.0", channel: "stable", published_at: "2026-11-20",
    notes_url: "https://updates.example.test/release",
    assets: { [platform]: { url: assetUrl, size: 3, sha256: "0".repeat(64) } },
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, Buffer.from(manifest), privateKey).toString("base64");
  const env = {
    ORCHIVOX_INSTALL_DIR: root, ORCHIVOX_MANIFEST_URL: manifestUrl,
    ORCHIVOX_RELEASE_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const previousEnv = Object.entries(env).map(([key]) => [key, process.env[key]] as const);
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const writeRecord = (version: string) => writeFile(join(root, "install.json"), JSON.stringify({
    schema: 1, version, platform, channel: "stable", method: "standalone", binary: "bin/orchivox",
    installed_at: "2026-11-20",
  }));

  try {
    Object.assign(process.env, env);
    globalThis.fetch = Object.assign(async (input: Parameters<typeof originalFetch>[0]) => {
      const url = String(input);
      requested.push(url);
      if (url === manifestUrl) return new Response(manifest);
      if (url === `${manifestUrl}.sig`) return new Response(signature);
      if (url === assetUrl) return new Response("bad");
      throw new Error(`Unexpected request ${url}`);
    }, { preconnect: originalFetch.preconnect });
    await writeRecord("1.0.0");
    const offers: UpdateOffer[] = [];
    const stages: string[] = [];
    let approved = false;
    const interaction = {
      confirm: async (offer: UpdateOffer) => { offers.push(offer); return approved; },
      stage: (stage: string) => { stages.push(stage); },
      progress() {},
    };
    expect(await runUpdate({ interaction })).toEqual({ output: "Update deferred.", updated: false });
    expect(offers[0]).toMatchObject({ current: "1.0.0", target: "9.0.0" });
    expect(requested).not.toContain(assetUrl);
    expect(stages).toEqual([]);
    approved = true;
    await expect(runUpdate({ interaction })).rejects.toThrow(/checksum|SHA-256/i);
    expect(requested).toContain(assetUrl);
    expect(stages).toEqual(["download"]);
    expect(JSON.parse(await Bun.file(join(root, "install.json")).text()).version).toBe("1.0.0");
    await writeRecord("9.0.0");
    expect((await runUpdate({ interaction })).output).toContain("Already up to date");
    expect(offers).toHaveLength(2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, original] of previousEnv) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("update picker defaults to Later and accepts the explicit Update now choice", async () => {
  for (const keys of [["\r"], ["\x1b[A", "\r"], ["\x1b"]]) {
    const ready = Promise.withResolvers<void>();
    const decided = Promise.withResolvers<boolean>();
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (enabled: boolean) => { if (enabled) ready.resolve(); },
      ref() {},
      unref() {},
    });
    let screen = "";
    const stdout = Object.assign(new Writable({
      write(chunk, _encoding, done) { screen = stripVTControlCharacters(chunk.toString()); done(); },
    }), { columns: 40, rows: 16 });
    const app = render(React.createElement(UpdatePanel, {
      view: { kind: "offer", offer: { current: "1.0.0", target: "1.1.0", detail: "stable · 40 MB download" } },
      width: 40, height: 12, theme: getTheme("tokyonight"), onDecision: decided.resolve,
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false });
    try {
      await ready.promise;
      expect(screen).toContain("❯ Later");
      if (keys.length === 2) {
        stdin.write(keys[0]);
        const deadline = Date.now() + 1000;
        while (!screen.includes("❯ Update now") && Date.now() < deadline) await Bun.sleep(5);
        expect(screen).toContain("❯ Update now");
      }
      stdin.write(keys.at(-1)!);
      expect(await decided.promise).toBe(keys.length === 2);
    } finally {
      app.unmount();
      app.cleanup();
    }
  }
});

test("the colored trail circles the outside of the emblem and leaves its cells unchanged", () => {
  const emblem = installationLogo();
  const positions = [];
  for (let frame = 0; frame < INSTALLATION_ORBIT_FRAMES; frame++) {
    const logo = installationLogo(frame);
    const row = logo.findIndex(([glyphs]) => glyphs.includes("⠿"));
    positions.push([row, logo[row][0].indexOf("⠿")]);
    for (const [index, [glyphs, tones]] of emblem.entries()) {
      for (let column = 0; column < glyphs.length; column++) {
        if (glyphs[column] === " ") continue;
        expect(logo[index][0][column]).toBe(glyphs[column]);
        expect(logo[index][1][column]).toBe(tones[column]);
      }
    }
  }
  expect([positions[0], positions[8], positions[14], positions[19]]).toEqual([[0, 4], [3, 13], [6, 6], [3, 0]]);
  expect(installationLogo(INSTALLATION_ORBIT_FRAMES)).toEqual(installationLogo(0));
});

test("interactive installer keeps the orbit moving across stages and clears it when finished", async () => {
  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      const frame = chunk.toString();
      if (frame.includes("Steps ")) frames.push(frame);
      done();
    },
  }) as unknown as NodeJS.WriteStream;
  const ui = new InstallerUI({ stdout, interactive: true, color: true, animations: true, env: {}, width: 20 });
  const logoRows = (frame: string) => stripVTControlCharacters(frame).split("\r").slice(1, INSTALLATION_LOGO_HEIGHT + 1);
  try {
    ui.startSteps([{ id: "download", label: "Download" }, { id: "link", label: "Link command" }]);
    ui.stage("download");
    const first = logoRows(frames.at(-1)!);
    expect(first[0]).toContain("⠿");
    expect(frames.at(-1)).toMatch(/\x1b\[38;5;\d+m⠿/);
    const deadline = Date.now() + 2000;
    while (frames.length < 3 && Date.now() < deadline) await Bun.sleep(20);
    const moving = logoRows(frames.at(-1)!);
    expect(moving).not.toEqual(first);
    ui.stage("link");
    expect(logoRows(frames.at(-1)!)).toEqual(moving);
    ui.finishSteps();
    const completed = frames.at(-1)!;
    expect(stripVTControlCharacters(completed)).toContain("Steps 2/2");
    expect(logoRows(completed)).toEqual(installationLogo().map(([glyphs]) => `${glyphs.trimEnd()}\n`));
    const count = frames.length;
    await Bun.sleep(150);
    expect(frames).toHaveLength(count);
  } finally {
    ui.close();
  }
});

test("installer keeps the emblem static with motion disabled and keeps piped output plain", () => {
  for (const interactive of [true, false]) {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, done) { output += chunk.toString(); done(); },
    }) as unknown as NodeJS.WriteStream;
    const ui = new InstallerUI({ stdout, interactive, color: false, animations: false, env: {}, width: 40 });
    try {
      ui.banner("1.1.0", "Windows x64");
      ui.startSteps([{ id: "download", label: "Download" }]);
      ui.stage("download");
      expect(output).toContain("Orchivox 1.1.0 for Windows x64");
      expect(output).not.toContain("⠿");
      expect(output.includes("\x1b")).toBe(interactive);
      expect(output.includes(installationLogo()[2][0].trim())).toBe(interactive);
    } finally {
      ui.close();
    }
  }
});

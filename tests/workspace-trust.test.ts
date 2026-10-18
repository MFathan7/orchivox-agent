import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";

import { WorkspaceTrustManager } from "../src/security/workspace-trust";
import { WorkspaceTrustPrompt } from "../src/tui/trust-modal";
import { parseCliArgs } from "../src/index";

describe("Workspace Trust System", () => {
  let tmpConfigFile: string;

  beforeEach(() => {
    tmpConfigFile = resolve(
      tmpdir(),
      `test-orchivox-trust-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
    );
  });

  afterEach(() => {
    if (existsSync(tmpConfigFile)) {
      try {
        unlinkSync(tmpConfigFile);
      } catch {
        // Ignore file cleanup errors in tests.
      }
    }
  });

  it("evaluates trust and persists to config file accurately", () => {
    const manager = new WorkspaceTrustManager(tmpConfigFile);
    const testDir = "/tmp/test-project-alpha";

    expect(manager.isTrusted(testDir)).toBe(false);
    expect(manager.listTrusted().length).toBe(0);

    manager.trust(testDir);
    expect(manager.isTrusted(testDir)).toBe(true);
    expect(manager.listTrusted()).toEqual([resolve(testDir)]);

    // Check that subdirectories of trusted workspace are also trusted
    expect(manager.isTrusted(`${testDir}/src/components`)).toBe(true);

    // Unrelated path should not be trusted
    expect(manager.isTrusted("/tmp/other-workspace")).toBe(false);

    // Verify persistence by reloading from the same file
    const reloaded = new WorkspaceTrustManager(tmpConfigFile);
    expect(reloaded.isTrusted(testDir)).toBe(true);
    expect(reloaded.isTrusted(`${testDir}/tests`)).toBe(true);

    // Untrust and verify
    reloaded.untrust(testDir);
    expect(reloaded.isTrusted(testDir)).toBe(false);
    expect(reloaded.listTrusted().length).toBe(0);
  });

  it("parses --trust flag in CLI args", () => {
    const optsWithTrust = parseCliArgs(["--trust"]);
    expect(optsWithTrust.trust).toBe(true);

    const optsWithoutTrust = parseCliArgs([]);
    expect(optsWithoutTrust.trust).toBeUndefined();
  });

  it("renders WorkspaceTrustPrompt without square brackets or y/n prompts", () => {
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    const testPath = "/home/developer/awesome-app";
    let trusted = false;
    let exited = false;

    const instance = render(
      React.createElement(WorkspaceTrustPrompt, {
        workspacePath: testPath,
        onTrust: () => {
          trusted = true;
        },
        onExit: () => {
          exited = true;
        },
      }),
      {
        stdout: stream as unknown as NodeJS.WriteStream,
        patchConsole: false,
      },
    );

    // Contains workspace path and trust question
    expect(output).toContain(testPath);
    expect(output).toContain("Do you trust the authors of the files in this workspace folder?");

    // Contains bracket-free choices
    expect(output).toContain("Yes, I trust this folder");
    expect(output).toContain("No, exit");
    expect(output).toContain("❯");

    // Must NOT contain square brackets or y/n prompts
    expect(output).not.toContain("[y/n]");
    expect(output).not.toContain("[Y/N]");
    expect(output).not.toContain("[Yes");
    expect(output).not.toContain("[No");

    instance.unmount();
    expect(trusted).toBe(false);
    expect(exited).toBe(false);
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface WorkspaceTrustConfig {
  trustedFolders: string[];
}

export class WorkspaceTrustManager {
  private readonly configPath: string;
  private trusted: Set<string>;

  constructor(customConfigPath?: string) {
    this.configPath = customConfigPath ?? resolve(homedir(), ".orchivox", "trusted_workspaces.json");
    this.trusted = this.load();
  }

  private load(): Set<string> {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<WorkspaceTrustConfig>;
        if (Array.isArray(parsed.trustedFolders)) {
          return new Set(parsed.trustedFolders.map((entry) => resolve(entry)));
        }
      }
    } catch {
      // Fallback to empty set on file read or parse failure.
    }
    return new Set();
  }

  private save(): void {
    try {
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: WorkspaceTrustConfig = {
        trustedFolders: Array.from(this.trusted).sort(),
      };
      writeFileSync(this.configPath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // Silently proceed if filesystem write is restricted.
    }
  }

  isTrusted(folderPath: string): boolean {
    const target = resolve(folderPath);
    for (const trustedPath of this.trusted) {
      if (
        target === trustedPath ||
        target.startsWith(trustedPath.endsWith("/") ? trustedPath : `${trustedPath}/`)
      ) {
        return true;
      }
    }
    return false;
  }

  trust(folderPath: string): void {
    const target = resolve(folderPath);
    this.trusted.add(target);
    this.save();
  }

  untrust(folderPath: string): void {
    const target = resolve(folderPath);
    this.trusted.delete(target);
    this.save();
  }

  listTrusted(): string[] {
    return Array.from(this.trusted).sort();
  }
}

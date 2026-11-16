import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareVersions, type UpdateCheck } from "./update";

export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

export async function updateNotice(options: {
  currentVersion: string;
  cachePath: string;
  check: () => Promise<UpdateCheck>;
  now?: number;
}): Promise<string | undefined> {
  const now = options.now ?? Date.now();
  let latest: string | undefined;
  try {
    const cache = JSON.parse(await readFile(options.cachePath, "utf8"));
    if (cache.current === options.currentVersion && typeof cache.at === "number" &&
      cache.at <= now && now - cache.at < UPDATE_CHECK_INTERVAL &&
      typeof cache.latest === "string" && versionPattern.test(cache.latest)) latest = cache.latest;
  } catch { /* An absent or invalid cache triggers a fresh check. */ }
  if (!latest) {
    try {
      const result = await options.check();
      if (!versionPattern.test(result.latest)) return undefined;
      latest = result.latest;
      try {
        await mkdir(dirname(options.cachePath), { recursive: true, mode: 0o700 });
        const temporary = `${options.cachePath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify({ current: options.currentVersion, latest, at: now }), { mode: 0o600 });
        await rename(temporary, options.cachePath);
      } catch { /* Cache failures must not interrupt the application. */ }
    } catch { return undefined; }
  }
  return compareVersions(latest, options.currentVersion) > 0
    ? `Update ${latest} · orchivox update` : undefined;
}
